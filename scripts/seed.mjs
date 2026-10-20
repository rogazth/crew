// Seeds a dev data set of its own: workspaces, worktrees with diffs, bots and
// sessions in every status, transcripts, routines and open tabs; a lead with
// subagents and background work, bots writing to each other, processes, and
// two remote machines (one served from this Mac, one unreachable). The app
// then runs on it without touching `Crew Dev`.
//
//   node scripts/seed.mjs                  → ~/Library/Application Support/Crew Design
//   CREW_USER_DATA=/some/dir node scripts/seed.mjs
//   npm run app:design                     → seeds if empty, then opens the app on it
//
// Re-running wipes the directory and seeds it again. Build the daemon first:
// cargo build -p crewd.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const DATA = process.env.CREW_USER_DATA || join(homedir(), "Library/Application Support/Crew Design");
const REPOS = join(DATA, "repos");
const TREES = join(DATA, "worktrees");

if (!existsSync(join(REPO, "target/debug/crewd"))) {
  console.error("seed: target/debug/crewd is missing. Build it with: cargo build -p crewd");
  process.exit(1);
}

rmSync(DATA, { recursive: true, force: true });
mkdirSync(REPOS, { recursive: true });
mkdirSync(TREES, { recursive: true });

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Crew",
      GIT_AUTHOR_EMAIL: "crew@example.com",
      GIT_COMMITTER_NAME: "Crew",
      GIT_COMMITTER_EMAIL: "crew@example.com",
    },
  })
    .toString()
    .trim();

function write(dir, files) {
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), contents);
  }
}

const lines = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

function makeRepo(name, files, base = REPOS) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  write(dir, files);
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", "initial");
  return dir;
}

/** A worktree on a new branch, with uncommitted work so its +/− shows. */
function makeTree(repo, branch, changes = {}) {
  const dir = join(TREES, repo.split("/").pop(), branch.replaceAll("/", "-"));
  git(repo, "worktree", "add", "--quiet", "-b", branch, dir, "HEAD");
  write(dir, changes);
  return dir;
}

// ---------- repos on disk ----------

// What the crew workspace's processes run: harmless node scripts that talk
// like the real thing, so a running one has logs worth reading.
const PROCESS_SCRIPTS = {
  "scripts/dev-server.mjs": `import { createServer } from "node:http";
const time = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const server = createServer((req, res) => {
  console.log(\`\${time()} [vite] GET \${req.url} 200\`);
  res.end("crew dev server\\n");
});
server.listen(0, "127.0.0.1", () => {
  console.log("\\n  VITE v6.3.5  ready in 412 ms\\n");
  console.log(\`  ➜  Local:   http://127.0.0.1:\${server.address().port}/\`);
  console.log("  ➜  press h + enter to show help\\n");
});
const files = ["src/App.tsx", "src/index.css", "src/chrome/TabBar.tsx", "src/lib/keymap.ts"];
let i = 0;
setInterval(() => console.log(\`\${time()} [vite] hmr update /\${files[i++ % files.length]}\`), 4000);
`,
  "scripts/api.mjs": `const routes = [["GET", "/api/sessions"], ["GET", "/api/workspaces"], ["POST", "/api/turns"], ["GET", "/api/health"]];
console.log(JSON.stringify({ level: "info", msg: "api listening", port: 8787 }));
let n = 0;
setInterval(() => {
  const [method, path] = routes[n++ % routes.length];
  const status = n % 11 === 0 ? 500 : 200;
  console.log(JSON.stringify({ level: status === 500 ? "error" : "info", method, path, status, ms: 3 + ((n * 7) % 40) }));
}, 1500);
`,
  "scripts/worker.mjs": `console.log("worker: connecting to redis://127.0.0.1:6390");
setTimeout(() => {
  console.error("Error: connect ECONNREFUSED 127.0.0.1:6390");
  console.error("    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)");
  process.exit(1);
}, 400);
`,
  "scripts/migrate.mjs": `const steps = ["0001_sessions", "0002_bots", "0003_routines"];
for (const [i, step] of steps.entries()) {
  if (i === 2) {
    console.error(\`✖ \${step}: SQLITE_CONSTRAINT: UNIQUE constraint failed: routines.session_id\`);
    process.exit(1);
  }
  console.log(\`✓ \${step}\`);
}
`,
  "scripts/storybook.mjs": `console.log("storybook v8.6.4 started");
console.log("  Local:            http://localhost:6006/");
setInterval(() => console.log("[storybook] compiled 214 stories"), 5000);
`,
};

const crewRepo = makeRepo("crew", {
  "README.md": "# Crew\n\nA desktop app for the coding agent CLIs you already pay for.\n",
  "src/App.tsx": lines(120, "// app line"),
  "src/chrome/TabBar.tsx": lines(80, "// tab line"),
  "src/lib/keymap.ts": lines(60, "// keymap line"),
  "src/index.css": lines(200, "/* css */"),
  "docs/ARCHITECTURE.md": "# Architecture\n\nTwo processes.\n",
  ...PROCESS_SCRIPTS,
});
const crewTrees = {
  tabs: makeTree(crewRepo, "feat/tab-indicators", {
    "src/chrome/TabBar.tsx": lines(140, "// tab line v2"),
    "src/chrome/TabStatus.tsx": lines(40, "// status"),
  }),
  keymap: makeTree(crewRepo, "fix/keymap-conflict", { "src/lib/keymap.ts": lines(64, "// keymap line") }),
  kumo: makeTree(crewRepo, "chore/drop-kumo", { "src/index.css": lines(90, "/* tokens */") }),
  avatars: makeTree(crewRepo, "exp/voxel-avatars-without-background-and-rounded-corners"),
};

const spendoRepo = makeRepo("spendo", {
  "README.md": "# Spendo\n\nPersonal finance.\n",
  "app/Models/Budget.php": lines(70, "// budget"),
  "app/Http/Controllers/TransactionController.php": lines(110, "// controller"),
});
const spendoTrees = {
  budgets: makeTree(spendoRepo, "feat/biweekly-budgets", { "app/Models/Budget.php": lines(98, "// budget v2") }),
};

const landingRepo = makeRepo("landing", { "index.html": "<!doctype html>\n<title>Landing</title>\n" });
const orcaRepo = makeRepo("orca", { "README.md": "# Orca\n", "cli/main.go": lines(50, "// go") });
const orcaTrees = {
  a: makeTree(orcaRepo, "feat/terminal-handoff"),
  b: makeTree(orcaRepo, "fix/socket-timeout", { "cli/main.go": lines(46, "// go") }),
  c: makeTree(orcaRepo, "spike/worktree-comments"),
};
// Not a git repo: a workspace with only its folder.
const notesDir = join(REPOS, "notes");
mkdirSync(notesDir, { recursive: true });
write(notesDir, { "inbox.md": "# Inbox\n\n- [ ] Tab indicators\n- [ ] Drop kumo\n" });

// ---------- the daemon ----------

const daemon = spawn(join(REPO, "target/debug/crewd"), [`--data-dir=${DATA}`], { stdio: ["pipe", "pipe", "pipe"] });
daemon.stderr.on("data", (chunk) => process.env.SEED_VERBOSE && process.stderr.write(`[crewd] ${chunk}`));

const info = await new Promise((resolve, reject) => {
  let buffer = "";
  daemon.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]));
  });
  daemon.on("exit", (code) => reject(new Error(`crewd exited ${code}`)));
});

/** A WebSocket to a crewd, authenticated, and a call that answers over it. */
async function connect(url, token) {
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
    if (parsed.id === undefined || !pending.has(parsed.id)) return;
    const { resolve, reject } = pending.get(parsed.id);
    pending.delete(parsed.id);
    parsed.ok ? resolve(parsed.result) : reject(new Error(parsed.error));
  });
  const call = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { rpc: call, close: () => socket.close() };
}

const local = await connect(info.url, info.token);
const rpc = local.rpc;

// ---------- workspaces, bots, sessions ----------

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();

const workspaces = {};
for (const [key, name, path] of [
  ["crew", "crew", crewRepo],
  ["spendo", "spendo", spendoRepo],
  ["orca", "orca", orcaRepo],
  ["landing", "landing", landingRepo],
  ["notes", "notes", notesDir],
]) {
  workspaces[key] = await rpc("workspace_create", { name, path });
}

// Enough more that the rail has to scroll: plain folders, no git, no sessions.
for (const name of ["api", "billing", "docs", "infra", "mobile", "search", "web", "analytics", "auth", "design-system", "emails", "cli", "sdk", "status"]) {
  const dir = join(REPOS, "more", name);
  mkdirSync(dir, { recursive: true });
  await rpc("workspace_create", { name, path: dir });
}

const sessions = [];
/**
 * `ago` is how long since it last did something; the daemon stamps now, the
 * database is corrected after it stops.
 */
async function session(ws, kind, name, { provider = "claude", model = "", worktree = null, status = "idle", description = "", ago = 0 } = {}) {
  const made = await rpc("session_create", {
    workspaceId: workspaces[ws].id,
    kind,
    name,
    provider,
    model,
    description,
    autonomy: "ask",
    worktree,
  });
  if (status !== "idle") await rpc("session_set_status", { id: made.id, status });
  const row = { ...made, ws, status, ago };
  sessions.push(row);
  return row;
}

// crew — the busy one: every status, every provider, a worktree per story.
const lead = await session("crew", "bot", "Planner", {
  model: "claude-opus-5-5",
  description: "Breaks the design pass into tickets and hands them out.",
  status: "working",
  ago: 0,
});
const showcase = await session("crew", "bot", "Showcase", {
  model: "claude-opus-5-5",
  description: "Every tool and every block the chat can draw, in one transcript.",
  status: "done",
  ago: 1 * MIN,
});
const reviewer = await session("crew", "bot", "Reviewer", {
  provider: "codex",
  model: "gpt-5.5-codex",
  description: "Reviews every diff before it lands.",
  status: "needs-input",
  ago: 3 * MIN,
});
const scribe = await session("crew", "bot", "Scribe", {
  provider: "opencode",
  description: "Keeps the docs in step with the code.",
  status: "done",
  ago: 12 * MIN,
});
await session("crew", "bot", "Tester", { provider: "cursor", status: "error", ago: 40 * MIN, description: "Runs the e2e suite." });
await session("crew", "bot", "Archivist", { ago: 3 * 24 * HOUR, description: "Idle for days." });
await session("crew", "terminal", "claude — design tokens", { status: "working", ago: 0 });
await session("crew", "terminal", "codex — release notes", { provider: "codex", status: "done", ago: 25 * MIN });
await session("crew", "terminal", "opencode", { provider: "opencode", ago: 5 * HOUR });

const tabsBot = await session("crew", "bot", "Indicator", {
  worktree: crewTrees.tabs,
  status: "working",
  description: "Explores tab status indicators.",
  ago: 0,
});
await session("crew", "bot", "Pixel", { worktree: crewTrees.tabs, provider: "codex", status: "needs-input", ago: 2 * MIN });
await session("crew", "terminal", "claude — tabs", { worktree: crewTrees.tabs, status: "done", ago: 8 * MIN });
await session("crew", "bot", "Keys", { worktree: crewTrees.keymap, provider: "cursor", status: "error", ago: 30 * MIN });
await session("crew", "terminal", "vitest --watch", { worktree: crewTrees.keymap, provider: "opencode", ago: 2 * HOUR });
await session("crew", "bot", "Sweeper", { worktree: crewTrees.kumo, status: "done", ago: 50 * MIN });
// crewTrees.avatars stays empty: a worktree with nobody in it.

// spendo — a quiet workspace with one thing waiting on you.
await session("spendo", "bot", "Ledger", { status: "needs-input", ago: 6 * MIN, description: "Imports bank statements." });
await session("spendo", "bot", "Budgeteer", { provider: "codex", ago: 26 * HOUR });
await session("spendo", "terminal", "php artisan test", { provider: "claude", ago: 3 * HOUR });
await session("spendo", "bot", "Biweekly", { worktree: spendoTrees.budgets, status: "working", ago: 0 });

// orca — lots of bots, to see the grid wrap and the folded faces stack.
for (const [i, name] of ["Atlas", "Beacon", "Comet", "Delta", "Echo", "Flint", "Gale"].entries()) {
  await session("orca", "bot", name, {
    provider: ["claude", "codex", "cursor", "opencode"][i % 4],
    status: ["idle", "working", "idle", "done", "idle", "idle", "error"][i],
    ago: i * 17 * MIN,
  });
}
await session("orca", "bot", "Handoff", { worktree: orcaTrees.a, status: "working" });
await session("orca", "bot", "Timeout", { worktree: orcaTrees.b, status: "needs-input", ago: MIN });
await session("orca", "terminal", "go test ./...", { worktree: orcaTrees.b, provider: "opencode", status: "done" });
await session("orca", "bot", "Commenter", { worktree: orcaTrees.c, ago: 4 * HOUR });
await session("orca", "bot", "A very long bot name that should truncate", { worktree: orcaTrees.c, provider: "codex", ago: 5 * HOUR });

// landing — one bot, nothing else. notes — empty.
await session("landing", "bot", "Copywriter", { provider: "opencode", ago: 2 * 24 * HOUR });

// Orchestration — a lead with a subagent in every state, one per provider,
// and a session it launched for the user. The daemon only makes subagents
// through `delegate`, so they start as terminals and the database makes them
// children of the lead once it stops.
const conductor = await session("crew", "bot", "Conductor", {
  model: "claude-opus-5-5",
  description: "Splits the 0.4 release into subagents and stitches their reports.",
  status: "working",
  ago: 0,
});
async function child(parent, name, options) {
  const row = await session(parent.ws, "terminal", name, options);
  row.parentId = parent.id;
  return row;
}
const scout = await child(conductor, "Scout", { model: "claude-sonnet-5-5", description: "Audit the dependencies for 0.4", ago: 9 * MIN });
const flake = await child(conductor, "Flake hunter", { provider: "codex", model: "gpt-5.5-codex", description: "Find why W1 fails one run in five", status: "working" });
const notes = await child(conductor, "Release notes", { provider: "opencode", description: "Draft the 0.4 release notes", status: "needs-input", ago: 2 * MIN });
const port = await child(conductor, "Linux port", { provider: "cursor", description: "Port the keymap tests to Linux", status: "error", ago: 6 * MIN });
const spike = await child(conductor, "Bundle spike", { model: "claude-haiku-5-5", description: "Try splitting the chat bundle", status: "exited", ago: 20 * MIN });
const checklist = await session("crew", "terminal", "Release checklist", { description: "Walk through the release by hand", ago: 15 * MIN });
checklist.launchedBy = conductor.id;

// The same from a session of the user's, not a bot: a terminal that delegated
// two subagents and left shells running, so its Work panel fills up too.
const payments = await session("crew", "terminal", "Payments migration", {
  model: "claude-opus-5-5",
  description: "Move billing onto the new ledger",
  status: "working",
  ago: 0,
});
const schemaCheck = await child(payments, "Schema check", { provider: "codex", model: "gpt-5.5-codex", description: "Diff the old and new schemas", status: "working" });
const backfill = await child(payments, "Backfill", { model: "claude-sonnet-5-5", description: "Write the backfill script", status: "working" });

// spendo — sessions of the user's, not bots, at full volume: one session that
// split the ledger rewrite into eight subagents (one of which delegates two of
// its own), launched two sessions for the user and left a dozen jobs running;
// and two sessions that write to each other while they build one feature.
const rewrite = await session("spendo", "terminal", "Ledger rewrite", {
  model: "claude-opus-5-5",
  description: "Rewrite the ledger on double-entry",
  status: "working",
  ago: 0,
});
const rw = {
  schema: await child(rewrite, "Schema audit", { provider: "codex", model: "gpt-5.5-codex", description: "Map every money column", status: "done", ago: 31 * MIN }),
  importer: await child(rewrite, "Importer", { model: "claude-sonnet-5-5", description: "Rebuild the bank statement importer", status: "working" }),
  rounding: await child(rewrite, "Rounding bug", { provider: "codex", model: "gpt-5.5-codex", description: "Find the off-by-one-cent in transfers", status: "needs-input", ago: 4 * MIN }),
  ui: await child(rewrite, "Budgets UI", { provider: "cursor", description: "Move the budget bars onto ledger totals", status: "working" }),
  bench: await child(rewrite, "Perf bench", { model: "claude-haiku-5-5", description: "Benchmark the monthly summary query", status: "error", ago: 9 * MIN }),
  docs: await child(rewrite, "Docs", { provider: "opencode", description: "Document the double-entry model", status: "done", ago: 13 * MIN }),
  cleanup: await child(rewrite, "Old API cleanup", { model: "claude-sonnet-5-5", description: "Delete the v1 transactions API", status: "exited", ago: 24 * MIN }),
  fixtures: await child(rewrite, "Fixtures", { provider: "codex", model: "gpt-5.5-codex", description: "Generate a year of fake statements", status: "working" }),
};
const csvParser = await child(rw.importer, "CSV parser", { provider: "cursor", description: "Parse the five bank CSV dialects", status: "done", ago: 7 * MIN });
const ofxParser = await child(rw.importer, "OFX parser", { provider: "opencode", description: "Parse OFX 1.x and 2.x", status: "working" });
const prReview = await session("spendo", "terminal", "Review ledger PR", { provider: "codex", model: "gpt-5.5-codex", description: "Review the ledger PR before it lands", status: "needs-input", ago: 2 * MIN });
prReview.launchedBy = rewrite.id;
const qaPass = await session("spendo", "terminal", "QA pass", { description: "Click through budgets on the new ledger", status: "done", ago: 11 * MIN });
qaPass.launchedBy = rewrite.id;
const apiSide = await session("spendo", "terminal", "Recurring API", { provider: "codex", model: "gpt-5.5-codex", description: "Endpoints for recurring transactions", status: "working" });
const uiSide = await session("spendo", "terminal", "Recurring UI", { model: "claude-sonnet-5-5", description: "Screens for recurring transactions", status: "needs-input", ago: MIN });

// ---------- routines ----------

async function routine(sessionId, name, schedule, { enabled = true, prompt = "" } = {}) {
  return rpc("routine_upsert", {
    id: null,
    sessionId,
    name,
    enabled,
    prompt: prompt || `Run the ${name.toLowerCase()} and report back.`,
    schedule: JSON.stringify(schedule),
    nextRunAt: enabled ? now + 3 * HOUR : null,
    createdBy: null,
  });
}
const digest = await routine(lead.id, "Morning digest", { kind: "daily", hour: 9, minute: 0, days: [] });
const sweep = await routine(reviewer.id, "PR sweep", { kind: "interval", minutes: 60 });
await routine(scribe.id, "Changelog", { kind: "daily", hour: 17, minute: 30, days: [5] }, { enabled: false });
await routine(tabsBot.id, "Nightly e2e", { kind: "cron", expression: "0 2 * * 1-5" });

// ---------- processes ----------

// Defined in the crew workspace. Runs live only in the daemon, so the seed
// keeps the definitions and app-design.mjs starts some once the app is up
// (seed-live.json): Web and API run, Worker crash-loops into crashed, Migrate
// exits 1, Storybook is started and stopped, Docs preview never runs, and
// Tunnel waits for the user to approve what Conductor asked for.
async function processDef(name, command, { autoRestart = false, env = {} } = {}) {
  return rpc("process_create", { workspaceId: workspaces.crew.id, name, command, env, autoRestart });
}
const live = { machines: [], processes: [] };
const startProcess = (made, stopAfterMs) => live.processes.push({ workspaceId: workspaces.crew.id, id: made.id, name: made.name, ...(stopAfterMs ? { stopAfterMs } : {}) });
startProcess(await processDef("Web", "node scripts/dev-server.mjs", { env: { NODE_ENV: "development" } }));
startProcess(await processDef("API", "node scripts/api.mjs", { autoRestart: true }));
startProcess(await processDef("Worker", "node scripts/worker.mjs", { autoRestart: true }));
startProcess(await processDef("Migrate", "node scripts/migrate.mjs"));
startProcess(await processDef("Storybook", "node scripts/storybook.mjs"), 3000);
await processDef("Docs preview", "npx serve docs -l 4000");
const tunnel = await processDef("Tunnel", "cloudflared tunnel --url http://localhost:5173");

// ---------- remote machines ----------

// devbox is a second crewd on this Mac, served the way a remote one is
// (`crewd serve`), with workspaces of its own: app-design.mjs keeps it up next
// to the app, so it reads as a machine that is online. gpu-box is an address
// nobody answers at: offline, with the workspace the window last saw there.
const MACHINE_PORT = 1431;
const MACHINE_TOKEN = "seed-devbox-token";
// A devbox left up by another app:design would answer instead, and take the seed.
const taken = await new Promise((resolve) => {
  const probe = createServer().once("error", () => resolve(true));
  probe.listen(MACHINE_PORT, "127.0.0.1", () => probe.close(() => resolve(false)));
});
if (taken) {
  console.error(`seed: port ${MACHINE_PORT} is taken, likely by another app:design's devbox. Quit it and seed again.`);
  daemon.kill("SIGTERM");
  process.exit(1);
}
const machineDir = join(DATA, "machines/devbox");
mkdirSync(machineDir, { recursive: true });
writeFileSync(join(machineDir, "token"), MACHINE_TOKEN, { mode: 0o600 });
const machine = spawn(join(REPO, "target/debug/crewd"), ["serve", `--listen=127.0.0.1:${MACHINE_PORT}`, `--data-dir=${machineDir}`], {
  stdio: ["ignore", "ignore", "pipe"],
});
machine.stderr.on("data", (chunk) => process.env.SEED_VERBOSE && process.stderr.write(`[devbox] ${chunk}`));
let remote = null;
for (let tries = 0; !remote; tries++) {
  remote = await connect(`ws://127.0.0.1:${MACHINE_PORT}`, MACHINE_TOKEN).catch((error) => {
    if (tries > 50) throw new Error(`devbox's crewd did not come up on ${MACHINE_PORT}: ${error.message ?? error}`);
    return new Promise((resolve) => setTimeout(() => resolve(null), 200));
  });
}
live.machines.push({ dir: machineDir, listen: `127.0.0.1:${MACHINE_PORT}` });

const machineRepos = join(machineDir, "home");
const apiRepo = makeRepo("api", { "README.md": "# api\n\nThe billing API.\n", "src/server.ts": lines(90, "// server"), "migrations/0007_invoices.sql": lines(30, "-- sql") }, machineRepos);
const infraRepo = makeRepo("infra", { "README.md": "# infra\n", "terraform/main.tf": lines(60, "# tf") }, machineRepos);
const remoteWorkspaces = {
  api: await remote.rpc("workspace_create", { name: "api", path: apiRepo }),
  infra: await remote.rpc("workspace_create", { name: "infra", path: infraRepo }),
};
const remoteSessions = [];
async function remoteSession(ws, kind, name, { provider = "claude", model = "", status = "idle", description = "", ago = 0 } = {}) {
  const made = await remote.rpc("session_create", { workspaceId: remoteWorkspaces[ws].id, kind, name, provider, model, description, autonomy: "ask", worktree: null });
  if (status !== "idle") await remote.rpc("session_set_status", { id: made.id, status });
  const row = { ...made, ws, status, ago };
  remoteSessions.push(row);
  return row;
}
const deployer = await remoteSession("api", "bot", "Deployer", { description: "Ships the API to staging.", status: "working" });
const migrator = await remoteSession("api", "bot", "Migrator", { provider: "codex", description: "Writes and checks the migrations.", status: "needs-input", ago: 4 * MIN });
await remoteSession("api", "bot", "Indexer", { provider: "opencode", status: "done", ago: 35 * MIN });
await remoteSession("api", "terminal", "htop", { ago: 2 * HOUR });
await remoteSession("infra", "bot", "Planner", { provider: "cursor", description: "Reads terraform plans.", ago: 26 * HOUR });
await remote.rpc("state_set", {
  key: `tabs:${remoteWorkspaces.api.id}`,
  value: JSON.stringify({ tabs: remoteSessions.filter((s) => s.ws === "api").map((s) => ({ id: `session:${s.id}`, kind: "session", sessionId: s.id })), activeId: `session:${deployer.id}` }),
});
remote.close();
machine.kill("SIGTERM");
await new Promise((resolve) => machine.on("exit", resolve));

const devbox = await rpc("remote_upsert", { id: "", name: "devbox", host: "127.0.0.1", port: MACHINE_PORT, user: "dev", ssh: "devbox" });
const gpuBox = await rpc("remote_upsert", { id: "", name: "gpu-box", host: "gpu-box.invalid", port: MACHINE_PORT, user: "gabriel", ssh: "gpu-box" });
// What the window keeps of an offline machine's workspaces, so the rail still lists them.
await rpc("state_set", {
  key: `env:workspaces:${gpuBox.id}`,
  value: JSON.stringify([{ id: "seed-gpu-training", name: "training", path: "/home/gabriel/training", createdAt: now - 9 * 24 * HOUR, home: false }]),
});
// Tokens live in the keychain; a dev build reads these as written (electron/remote-tokens.ts).
writeFileSync(join(DATA, "remote-tokens.json"), JSON.stringify({ [devbox.id]: `plain:${MACHINE_TOKEN}`, [gpuBox.id]: "plain:unreachable" }), { mode: 0o600 });

// ---------- app state ----------

const sessionTab = (s) => ({ id: `session:${s.id}`, kind: "session", sessionId: s.id });
const crewSessions = sessions.filter((s) => s.ws === "crew" && s.worktree === null);
await rpc("state_set", {
  key: `tabs:${workspaces.crew.id}`,
  value: JSON.stringify({
    tabs: [
      ...crewSessions.slice(0, 6).map(sessionTab),
      sessionTab(conductor),
      sessionTab(payments),
      { id: `file:${crewRepo}/README.md`, kind: "file", path: `${crewRepo}/README.md`, relative: "README.md" },
      { id: "browser:seed-linear", kind: "browser", url: "https://linear.app", title: "Linear" },
    ],
    activeId: `session:${lead.id}`,
  }),
});
await rpc("state_set", {
  key: `tabs:${workspaces.crew.id}@${crewTrees.tabs}`,
  value: JSON.stringify({
    tabs: sessions.filter((s) => s.worktree === crewTrees.tabs).map(sessionTab),
    activeId: `session:${tabsBot.id}`,
  }),
});
await rpc("state_set", {
  key: `tabs:${workspaces.spendo.id}`,
  value: JSON.stringify({ tabs: [rewrite, apiSide, uiSide, prReview].map(sessionTab), activeId: `session:${rewrite.id}` }),
});
await rpc("active_workspace_set", { id: workspaces.crew.id });
await rpc("state_set", { key: "sidebar:width", value: "300" });

local.close();
daemon.kill("SIGTERM");
await new Promise((resolve) => daemon.on("exit", resolve));

// ---------- straight to the database: times, transcripts, run history ----------

const sql = [];
const q = (text) => `'${String(text).replaceAll("'", "''")}'`;
for (const s of sessions) {
  const at = now - s.ago;
  sql.push(`UPDATE sessions SET updated_at = ${at}, created_at = ${at - 2 * HOUR} WHERE id = ${q(s.id)};`);
}

/**
 * `blocks` are written oldest first, a minute apart and ending now; a block
 * with `ago` pins its own time and the ones after it count on from there.
 */
function transcript(sessionId, blocks, out = sql) {
  let at = now - blocks.length * MIN;
  blocks.forEach((block, index) => {
    // 1-based, as crewd writes it: a search hit's `at` is the block read_session numbers.
    const pos = index + 1;
    const { role, text = "", ago, ...extra } = block;
    at = ago !== undefined ? now - ago : at + MIN;
    out.push(
      `INSERT INTO messages (session_id, pos, id, role, text, at, extra_json) VALUES (${q(sessionId)}, ${pos}, ${q(
        `seed-${sessionId}-${pos}`,
      )}, ${q(role)}, ${q(text)}, ${at}, ${q(JSON.stringify(extra))});`,
    );
  });
}

let calls = 0;
const tool = (name, title, detail, status = "completed") => ({
  role: "tool",
  tool: { callId: `call-${++calls}`, name, title, status, detail },
});
const usage = (seconds, input, output, cost) => ({
  usage: { durationMs: seconds * 1000, inputTokens: input, outputTokens: output, costUsd: cost },
});

// A picture to attach: the app's own icon, copied into the repo.
const shot = join(crewRepo, "docs/tabs-before.png");
execFileSync("cp", [join(REPO, "build/icon.png"), shot]);

const RICH = `## Plan for the design pass

Three moves, in this order, so nothing half-migrated ships:

1. **Tokens first** — our own palette on \`:root\`, so nothing reads from kumo.
2. **Icons** — one set, darker by default. See \`src/chrome/kit.tsx\`.
3. **Tabs** — status you can read from across the room.

> Kumo is only holding up the sidebar today; everything else already sits on Base UI.

| Surface | Today | After |
| --- | --- | --- |
| Sidebar | kumo \`Sidebar\` | \`SidebarShell\` |
| Icons | Phosphor + local SVG | Lucide |
| Tokens | \`--color-kumo-*\` | \`--color-*\` |

\`\`\`tsx
export function SidebarShell({ open, width, children }: Props) {
  if (!open) return null;
  return <aside style={{ width }}>{children}</aside>;
}
\`\`\`

- [x] Inventory the kumo imports
- [ ] Swap the tokens
- [ ] Move the sidebar

More on the approach in [Linear's design notes](https://linear.app/now).`;

transcript(lead.id, [
  { role: "user", text: "What's left before we can drop kumo?", ago: 26 * HOUR },
  { role: "assistant", text: "Only the sidebar and a handful of form controls. I'll write up a plan tomorrow.", ...usage(14, 12_400, 380, 0.04) },
  {
    role: "user",
    text: "Plan the design pass: kumo out, one icon set, and tabs that say more. Start from @src/index.css — screenshot of the tabs today attached.",
    files: [{ name: "tabs-before.png", path: shot, kind: "image", size: 48213 }],
    ago: 40 * MIN,
  },
  { role: "reasoning", text: "The user wants a plan, not code yet. Look at how deep kumo goes first: the tokens in index.css, then every component import. The sidebar is the only structural dependency." },
  tool("Read", "Read src/index.css", { kind: "file", path: "src/index.css", lineStart: 1, lineEnd: 40, preview: ":root {\n  --color-canvas: var(--color-kumo-base);\n  --color-sidebar: var(--color-kumo-elevated);\n}" }),
  tool("Grep", "Search kumo-", { kind: "search", query: "kumo-", matches: 312 }),
  tool("Grep", "Search @cloudflare/kumo", { kind: "search", query: "@cloudflare/kumo", matches: 11 }),
  tool("Read", "Read src/App.tsx", { kind: "file", path: "src/App.tsx", lineStart: 170, lineEnd: 190 }),
  tool("WebFetch", "Fetch base-ui.com/react/components", { kind: "fetch", url: "https://base-ui.com/react/components/collapsible", title: "Collapsible · Base UI" }),
  tool("Bash", "Run npm run check", { kind: "command", command: "npm run check", exitCode: 0, output: "✓ eslint\n✓ tsc\n✓ 318 tests passed\n✓ react-doctor" }),
  { role: "assistant", text: RICH, ...usage(94, 48_200, 2_140, 0.31) },
  { role: "user", text: "Go ahead with step 1, and keep the sidebar layout as it is." },
  tool("Edit", "Edit src/index.css", { kind: "edit", path: "src/index.css", added: 48, removed: 31 }),
  tool("Bash", "Run npx tsc --noEmit", { kind: "command", command: "npx tsc --noEmit", exitCode: 2, output: "src/App.tsx(180,39): error TS2304: Cannot find name 'kumo'." }, "failed"),
  { role: "assistant", text: "One reference left in `src/App.tsx`. Fixing it now." },
  {
    role: "approval",
    text: "Edit src/App.tsx",
    approval: {
      requestId: 7,
      name: "Edit",
      input: {
        file_path: `${crewRepo}/src/App.tsx`,
        old_string: '      style={{ "--sidebar-bg": "var(--color-kumo-elevated)" }}',
        new_string: "      style={{ width: sidebar.width }}",
      },
    },
  },
]);

transcript(reviewer.id, [
  { role: "user", text: "Review the keymap change on fix/keymap-conflict.", ago: 12 * MIN },
  tool("Bash", "Run git diff main", { kind: "command", command: "git diff main -- src/lib/keymap.ts", exitCode: 0, output: "+export function yields(spec, input, others) {\n+  …\n+}" }),
  tool("Read", "Read src/lib/keymap.test.ts", { kind: "file", path: "src/lib/keymap.test.ts" }),
  { role: "assistant", text: "The change is small and tested. One decision is yours before I approve." },
  {
    role: "question",
    text: "Keymap",
    question: {
      requestId: 3,
      questions: [
        {
          question: "When a key matches one command by its character and another by its physical key, which one wins?",
          header: "Precedence",
          multiSelect: false,
          options: [
            { label: "The character", description: "⌘- is zoom out on every layout." },
            { label: "The physical key", description: "⌘/ stays where US keyboards have it." },
          ],
        },
        {
          question: "Which layouts should the e2e suite cover?",
          header: "Layouts",
          multiSelect: true,
          options: [{ label: "US" }, { label: "Latin American" }, { label: "Dvorak" }],
        },
      ],
    },
  },
]);

const TEST_LOG = [
  "> crew@0.1.14 test",
  "> vitest run",
  "",
  ...Array.from({ length: 58 }, (_, i) => ` ✓ src/lib/${["tabs", "keymap", "blocks", "activity", "toolDetail"][i % 5]}.test.ts (${12 + i} tests) ${3 + (i % 7)}ms`),
  "",
  " Test Files  58 passed (58)",
  "      Tests  1038 passed (1038)",
].join("\n");

const SHOWCASE_REPLY = `## What changed

The chat now draws each tool as what it did. Here is the tour, block by block.

### Lists

1. **Ordered** items keep their numbers
   - and nest a bullet list
     - two levels deep
2. With \`inline code\` and a path like \`src/lib/toolDetail.ts\`

- [x] A finished task
- [ ] One still open

### Quotes and callouts

> A plain quote, for when the agent cites something.
> It can run over two lines.

> [!NOTE]
> Callouts render with an icon and a tint.

> [!WARNING]
> This one would ship a breaking change.

### Tables

| Tool | Row says | Opens to |
| --- | --- | --- |
| Edit | \`src/App.tsx +3 −1\` | the diff |
| MCP | \`chrome-devtools · take snapshot\` | input and result |
| Task | the subagent's job | its report |

### Code

\`\`\`ts title="src/lib/toolDetail.ts"
export function prettyTitle(title: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(title);
  return mcp ? mcpLabel(mcp[1]!, mcp[2]!) : title;
}
\`\`\`

\`\`\`bash
npm run check && git push
\`\`\`

\`\`\`diff
- const title = block.tool?.title ?? block.text;
+ const title = prettyTitle(block.tool?.title ?? block.text);
\`\`\`

\`\`\`mermaid
flowchart LR
  Provider --> Daemon --> Transcript --> Chat
\`\`\`

---

Inline math like $$e^{i\\pi} + 1 = 0$$ and a block:

$$
\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}
$$

Sources: the t3code timeline[^1] and [Zeron's tool chips](https://example.com/zeron).

[^1]: \`apps/web/src/components/chat/MessagesTimeline.tsx\``;

transcript(showcase.id, [
  { role: "user", text: "Show me everything the chat can draw.", ago: 9 * MIN },
  { role: "reasoning", text: "I'll plan it first, then touch each kind of tool once so every row shows up." },
  tool("TodoWrite", "Todos", {
    kind: "todo",
    items: [
      { text: "Read the tool rows", status: "completed" },
      { text: "Exercise every tool", status: "inProgress" },
      { text: "Write the tour", status: "pending" },
    ],
  }),
  tool("Read", "Read toolDetail.ts", {
    kind: "file",
    path: "src/lib/toolDetail.ts",
    lineStart: 1,
    lineEnd: 12,
    preview: 'import { botLabel } from "./botNames";\nimport type { Block, ToolDetail } from "./protocol";\n\nexport type ToolLine = {\n  text: string;\n  mono: boolean;\n};',
  }),
  tool("Grep", "Grep toolLine", {
    kind: "search",
    query: "toolLine",
    output: "src/lib/toolDetail.ts\nsrc/surfaces/chat/Activity.tsx\nsrc/lib/toolDetail.test.ts",
  }),
  tool("ToolSearch", "Find tools chrome", { kind: "search", query: "select:mcp__chrome-devtools__take_snapshot" }),
  tool("Task", "Find where tools are titled", {
    kind: "agent",
    description: "Find where tools are titled",
    agentType: "Explore",
    prompt: "Where does the daemon decide a tool row's title? Report file:line.",
    output: "Titles come from **`tool_label`** in `crates/crew-core/src/providers/claude.rs`.\n\n- MCP names split on `__`\n- Crew's own tools get a verb\n- Everything else falls back to the tool name",
  }),
  tool("mcp__chrome-devtools__take_snapshot", "chrome-devtools · take snapshot", {
    kind: "mcp",
    server: "chrome-devtools",
    tool: "take_snapshot",
    input: '{\n  "verbose": false\n}',
    output: '[{"uid":"1_0","role":"RootWebArea","name":"Crew"},{"uid":"1_1","role":"button","name":"New bot"}]',
  }),
  tool("mcp__crew__list_peers", "mcp__crew__list_peers", {
    kind: "output",
    text: '[\n  {\n    "id": "5888c0",\n    "name": "Planner",\n    "kind": "bot",\n    "write": true\n  }\n]',
  }),
  { role: "assistant", text: "Found it. Now the edits." },
  tool("Edit", "Edit toolDetail.ts", {
    kind: "edit",
    path: "src/lib/toolDetail.ts",
    added: 2,
    removed: 1,
    hunks: [
      {
        before: "  const title = block.tool?.title ?? block.text;",
        after: "  // The result is the body, never the line.\n  const title = prettyTitle(block.tool?.title ?? block.text);",
      },
    ],
  }),
  tool("Write", "Write notes.md", {
    kind: "edit",
    path: "docs/notes.md",
    added: 3,
    hunks: [{ before: "", after: "# Notes\n\nEvery tool gets a renderer.\n" }],
  }),
  tool("Bash", "npm test", { kind: "command", command: "npm test", exitCode: 0, output: TEST_LOG }),
  tool("mcp__linear__save_issue", "linear · save issue", {
    kind: "mcp",
    server: "linear",
    tool: "save_issue",
    input: '{\n  "title": "Chat timeline"\n}',
    output: "Unauthorized: the Linear token expired.",
  }, "failed"),
  tool("ExitPlanMode", "Plan", {
    kind: "plan",
    text: "## Plan\n\n1. Fix the `[` rows\n2. Give every tool a renderer\n3. Fold finished turns",
  }),
  tool("TodoWrite", "Todos", {
    kind: "todo",
    items: [
      { text: "Read the tool rows", status: "completed" },
      { text: "Exercise every tool", status: "completed" },
      { text: "Write the tour", status: "completed" },
    ],
  }),
  { role: "assistant", text: SHOWCASE_REPLY, ...usage(252, 48_200, 3_900, 0.61) },
]);

transcript(scribe.id, [
  { role: "user", text: "The design pass landed. Update the README.", ago: 30 * MIN },
  {
    role: "user",
    text: "Heads up: the dev profile moved. `npm run app:design` now seeds its own data — please document it.\n\nThanks!",
    from_bot: { id: lead.id, name: "Planner" },
  },
  tool("Read", "Read README.md", { kind: "file", path: "README.md" }),
  tool("Edit", "Edit README.md", { kind: "edit", path: "README.md", added: 12, removed: 2 }),
  tool("Message", "Message Planner", { kind: "message", to: "Planner", text: "README updated with the design profile." }),
  { role: "assistant", text: "Done. `npm run app:design` is documented under **Development**, with the reseed flag.", ...usage(38, 9_100, 410, 0.05) },
]);

transcript(tabsBot.id, [
  { role: "user", text: "Explore how tabs could say more: working, waiting, unread, failed.", ago: 6 * MIN },
  { role: "assistant", text: "Trying three treatments on the pill: a ring on the face, a tinted pill when it waits on you, and a progress sliver while it works." },
  tool("Bash", "Run npm run dev", { kind: "command", command: "npm run dev" }, "pending"),
]);

const tester = sessions.find((s) => s.name === "Tester");
transcript(tester.id, [
  { role: "user", text: "Run the e2e suite.", ago: 45 * MIN },
  tool("Bash", "Run npm run e2e", { kind: "command", command: "npm run e2e", exitCode: 1, output: "✖ W1: a worktree is made, worked in, dirtied and removed\n  Error: git lists the new worktree: gave up after 10000ms" }, "failed"),
  { role: "system", text: "cursor-agent exited with code 1." },
]);

// ---------- letters between sessions ----------

let letters = 0;
/** A letter that was handed over: its mailbox row. The blocks on both sides carry the id it returns. */
function mail(from, to, text, ago, { kind = "message", fromKind = null, out = sql } = {}) {
  const id = `seed-letter-${++letters}`;
  const at = now - ago;
  out.push(
    `INSERT INTO mailbox (id, to_session, from_session, from_name, text, at, delivered_at, from_kind, kind) VALUES (${q(id)}, ${q(to.id)}, ${q(
      from.id,
    )}, ${q(from.name)}, ${q(text)}, ${at}, ${at}, ${fromKind ? q(fromKind) : "NULL"}, ${q(kind)});`,
  );
  return id;
}
/** The letter as its reader's transcript shows it. A subagent writes as a `session`; a bot has no kind. */
const received = (from, text, letterId, ago, { letterKind = "message", fromKind } = {}) => ({
  role: "user",
  text,
  ago,
  from_bot: { id: from.id, name: from.name, ...(fromKind ? { kind: fromKind } : {}) },
  letter_id: letterId,
  letter_kind: letterKind,
});
/** The sender's `send_message` row for it. */
const sent = (to, text, letterId, ago, delivery = "started") => ({
  ...tool("mcp__crew__send_message", `Message ${to.name}`, { kind: "message", to: to.name, toId: to.id, toName: to.name, text, letterId, delivery }),
  ago,
});
/** A letter both ways at once: the mailbox row, the sender's row and the reader's block. */
function letter(from, to, text, ago, delivery) {
  const id = mail(from, to, text, ago);
  return [sent(to, text, id, ago, delivery), received(from, text, id, ago)];
}
/**
 * How a subagent's last turn ended, at the end of its transcript: the event
 * its row and its parent's panel read (`turn`, `needs-input`, `error`,
 * `exited`), and the cursor that points at it.
 */
function settle(s, blocks, kind, outcome, { report = "", request = null, out = sql } = {}) {
  out.push(
    `INSERT INTO session_events (session_id, cursor, kind, outcome, report, request, at) VALUES (${q(s.id)}, ${blocks.length}, ${q(kind)}, ${q(
      outcome,
    )}, ${q(report)}, ${request ? q(JSON.stringify(request)) : "NULL"}, ${now - s.ago});`,
  );
  out.push(`UPDATE sessions SET cursor = ${blocks.length} WHERE id = ${q(s.id)};`);
}

// ---------- orchestration: Conductor, its subagents and its background work ----------

for (const c of [scout, flake, notes, port, spike, schemaCheck, backfill]) {
  sql.push(`UPDATE sessions SET kind = 'child', parent_id = ${q(c.parentId)} WHERE id = ${q(c.id)};`);
}
sql.push(`UPDATE sessions SET launched_by = ${q(conductor.id)} WHERE id = ${q(checklist.id)};`);

const JOBS = {
  scout: "Audit the dependencies for 0.4: what is outdated, what has advisories, and what we can bump without touching code. Report a table.",
  flake: "W1 in e2e/worktrees.spec.ts fails about one run in five. Find out why and fix it; don't just raise the timeout.",
  notes: "Draft the 0.4 release notes from the commits since v0.3.13. Group them by what a user notices.",
  port: "Make src/lib/keymap.test.ts pass on Linux. Run it in the ubuntu:24.04 container.",
  spike: "Try splitting the chat bundle so streamdown loads on first use. Measure before and after.",
  checklist: "Walk the user through the 0.4 release by hand: version bump, tag, notarize, upload.",
};
const delegated = {};
function delegate(c, prompt, ago) {
  const id = mail(conductor, c, prompt, ago);
  delegated[c.id] = { id, text: prompt };
  return [
    {
      ...tool("mcp__crew__delegate", `Delegate to ${c.name}`, { kind: "message", to: c.name, toId: c.id, toName: c.name, text: prompt, letterId: id, what: "start" }),
      ago,
    },
    { role: "system", text: `Delegated to subagent ${c.name} (${c.id})`, letter_id: id },
  ];
}
/** A subagent's first block: the prompt it was started on, as a letter from Conductor. */
const started = (c, ago) => received(conductor, delegated[c.id].text, delegated[c.id].id, ago, { letterKind: "started" });

const SCOUT_REPORT = `Dependencies for 0.4: **4 safe bumps, 1 advisory, 1 to hold**.

| Package | Now | Latest | Call |
| --- | --- | --- | --- |
| \`vite\` | 6.3.5 | 6.4.1 | bump |
| \`@base-ui/react\` | 1.0.0-beta.4 | 1.0.0 | bump |
| \`lucide-react\` | 0.511.0 | 0.548.0 | bump |
| \`streamdown\` | 1.4.0 | 1.6.2 | bump |
| \`electron\` | 37.2.0 | 38.1.0 | **hold**: drops macOS 11 |

\`npm audit\` flags \`tar-fs\` (moderate, via electron-builder): dev only, never shipped.`;

const checklistLaunch = mail(conductor, checklist, JOBS.checklist, 32 * MIN);
const backgroundTask = tool("Task", "Audit bundle size", {
  kind: "agent",
  description: "Audit bundle size",
  agentType: "general-purpose",
  prompt: "Find what makes the chat bundle 2.1 MB and what of it could load later. Don't change code.",
  background: true,
  state: "running",
  activity: "Reading vite.config.ts",
  steps: [
    { id: "seed-step-1", role: "tool", text: "", tool: { callId: "step-1", name: "Bash", title: "Run npx vite build", status: "completed", detail: { kind: "command", command: "npx vite build --mode analyze", exitCode: 0, output: "dist/assets/chat-4f1c.js  2,148.31 kB │ gzip: 611.02 kB" } } },
    { id: "seed-step-2", role: "assistant", text: "streamdown and mermaid are 1.3 MB of it. Checking how they are imported." },
    { id: "seed-step-3", role: "tool", text: "", tool: { callId: "step-3", name: "Read", title: "Read vite.config.ts", status: "pending", detail: { kind: "file", path: "vite.config.ts" } } },
  ],
});
const devServer = tool("Bash", "Dev server", { kind: "command", command: "npm run dev", output: "Command running in background with ID: bg-dev" });
const vitest = tool("Bash", `Run npx vitest --watch`, { kind: "command", command: `cd ${crewRepo} && npx vitest --watch src/lib/keymap.test.ts`, output: "Command running in background with ID: bg-vitest" });
const monitor = tool("Monitor", "Watch crewd for errors", { kind: "command", command: "tail -f ~/.crew/logs/crewd.log | grep --line-buffered ERROR" });
const typecheck = tool("Bash", "Type check", { kind: "command", command: "npx tsc --noEmit", exitCode: 0, output: "" });
const e2e = tool("Bash", "Run npm run e2e -- --grep W1", { kind: "command", command: "npm run e2e -- --grep W1", exitCode: 1, output: "Command running in background with ID: bg-e2e" });

const conductorBlocks = [
  { role: "user", text: "Ship 0.4: audit the deps, fix the flaky W1, write the release notes and get the keymap tests green on Linux. Use subagents.", ago: 40 * MIN },
  { role: "reasoning", text: "Four independent jobs, one per provider so they run side by side. A fifth, the bundle split, is a spike I can stop if it drags." },
  tool("TodoWrite", "Todos", {
    kind: "todo",
    items: [
      { text: "Dependency audit", status: "completed" },
      { text: "Fix flaky W1", status: "inProgress" },
      { text: "Release notes", status: "inProgress" },
      { text: "Keymap tests on Linux", status: "pending" },
    ],
  }),
  ...delegate(scout, JOBS.scout, 37 * MIN),
  ...delegate(flake, JOBS.flake, 36 * MIN),
  ...delegate(notes, JOBS.notes, 35 * MIN),
  ...delegate(port, JOBS.port, 34 * MIN),
  ...delegate(spike, JOBS.spike, 33 * MIN),
  {
    ...tool("mcp__crew__start_session", "Start Release checklist", {
      kind: "message",
      to: checklist.name,
      toId: checklist.id,
      toName: checklist.name,
      text: JOBS.checklist,
      letterId: checklistLaunch,
      what: "launch",
    }),
    ago: 32 * MIN,
  },
  { role: "system", text: `Started session ${checklist.name} (${checklist.id})`, letter_id: checklistLaunch },
  { ...backgroundTask, ago: 31 * MIN },
  { ...devServer, ago: 30 * MIN },
  vitest,
  monitor,
  { role: "assistant", text: "Five subagents are on it and a bundle audit runs in the background. I'll stitch their reports as they land." },
  {
    ...tool("mcp__crew__stop_session", "Stop Bundle spike", { kind: "crew", verb: "stop_session", targets: [{ id: spike.id, name: spike.name, provider: "claude" }], count: 0 }),
    ago: 20 * MIN,
  },
  { ...typecheck, ago: 18 * MIN },
  { ...e2e, ago: 14 * MIN },
  {
    ...tool("mcp__crew__save_process", "Save process Tunnel", {
      kind: "output",
      text: "Tunnel is waiting for the user's approval: cloudflared tunnel --url http://localhost:5173",
    }),
    ago: 12 * MIN,
  },
  received(scout, SCOUT_REPORT, mail(scout, conductor, SCOUT_REPORT, 9 * MIN, { kind: "report", fromKind: "session" }), 9 * MIN, {
    letterKind: "report",
    fromKind: "session",
  }),
];
const PORT_FAIL = "Its turn failed: cursor-agent exited with code 1\nWhat it said last:\n\nThe container has no `xkbcommon`, so the layout tests can't load a keymap. Installing it next.";
conductorBlocks.push(
  received(port, PORT_FAIL, mail(port, conductor, PORT_FAIL, 6 * MIN, { kind: "report", fromKind: "session" }), 6 * MIN, { letterKind: "report", fromKind: "session" }),
  {
    ...tool("mcp__crew__read_session", "Read Flake hunter", { kind: "crew", verb: "read_session", targets: [{ id: flake.id, name: flake.name, provider: "codex" }], count: 12 }),
    ago: 3 * MIN,
  },
);
const NOTES_ASK = "Which change leads the 0.4 notes?\n- Subagents: delegate work to any provider\n- Remote machines over Tailscale\n- Commands panel";
conductorBlocks.push(
  received(notes, NOTES_ASK, mail(notes, conductor, NOTES_ASK, 2 * MIN, { kind: "question", fromKind: "session" }), 2 * MIN, { letterKind: "question", fromKind: "session" }),
);
const steer = "The race is in `git worktree list` while the add is still writing. Wait on the lock file instead of polling.";
const [steerSent, steerReceived] = letter(conductor, flake, steer, MIN, "steered");
conductorBlocks.push(steerSent, tool("Edit", "Edit package.json", { kind: "edit", path: "package.json", added: 4, removed: 4 }, "pending"));
transcript(conductor.id, conductorBlocks);

const scoutBlocks = [
  started(scout, 37 * MIN),
  tool("Bash", "Run npm outdated", { kind: "command", command: "npm outdated", exitCode: 1, output: "Package          Current        Wanted  Latest\nvite               6.3.5         6.4.1   6.4.1\nlucide-react     0.511.0       0.548.0 0.548.0\nelectron          37.2.0        37.2.0  38.1.0" }),
  tool("Read", "Read package.json", { kind: "file", path: "package.json" }),
  tool("Bash", "Run npm audit --omit dev", { kind: "command", command: "npm audit --omit dev", exitCode: 0, output: "found 0 vulnerabilities" }),
  { role: "assistant", text: SCOUT_REPORT, ...usage(212, 31_400, 1_020, 0.09) },
  { role: "system", text: "Turn ended" },
];
transcript(scout.id, scoutBlocks);
settle(scout, scoutBlocks, "turn", "completed", { report: SCOUT_REPORT });

const flakeBlocks = [
  started(flake, 36 * MIN),
  tool("Bash", "Run playwright 20 times", { kind: "command", command: "npx playwright test e2e/worktrees.spec.ts --repeat-each 20", exitCode: 1, output: "  4 failed\n    [electron] › worktrees.spec.ts:12:3 › W1: a worktree is made, worked in, dirtied and removed\n  16 passed (3.8m)" }, "failed"),
  tool("Read", "Read e2e/worktrees.spec.ts", { kind: "file", path: "e2e/worktrees.spec.ts", lineStart: 1, lineEnd: 60 }),
  { role: "reasoning", text: "Every failure is the `git lists the new worktree` wait. The list runs while `git worktree add` still holds its lock." },
  steerReceived,
  tool("Edit", "Edit e2e/worktrees.spec.ts", { kind: "edit", path: "e2e/worktrees.spec.ts", added: 6, removed: 2 }),
  tool("Bash", "Run playwright 40 times", { kind: "command", command: "npx playwright test e2e/worktrees.spec.ts --repeat-each 40" }, "pending"),
];
transcript(flake.id, flakeBlocks);

const notesBlocks = [
  started(notes, 35 * MIN),
  tool("Bash", "Run git log", { kind: "command", command: "git log --oneline v0.3.13..HEAD", exitCode: 0, output: "adc0090 fix: drop the wake note for tasks that ran in the foreground\nfe0e1ca feat: upload big attachments to remote machines in pieces\n5f4c244 feat: show a nameless shell's command as a one-line preview" }),
  tool("Read", "Read CHANGELOG.md", { kind: "file", path: "CHANGELOG.md", lineStart: 1, lineEnd: 40 }),
  { role: "assistant", text: "The draft is ready except for its lead. One call is yours." },
  {
    role: "question",
    text: "Release notes",
    question: {
      requestId: 11,
      questions: [
        {
          question: "Which change leads the 0.4 notes?",
          header: "Headline",
          multiSelect: false,
          options: [
            { label: "Subagents", description: "Delegate work to any provider and watch it in the panel." },
            { label: "Remote machines", description: "Run sessions on a box over Tailscale." },
            { label: "Commands panel", description: "Dev servers and workers next to the chat." },
          ],
        },
      ],
    },
  },
];
transcript(notes.id, notesBlocks);
settle(notes, notesBlocks, "needs-input", "", { request: { kind: "question", questions: [{ question: "Which change leads the 0.4 notes?" }] } });

const portBlocks = [
  started(port, 34 * MIN),
  tool("Bash", "Run the tests in ubuntu:24.04", { kind: "command", command: "docker run --rm -v $PWD:/app -w /app ubuntu:24.04 npx vitest run src/lib/keymap.test.ts", exitCode: 1, output: "Error: libxkbcommon.so.0: cannot open shared object file: No such file or directory" }, "failed"),
  { role: "assistant", text: "The container has no `xkbcommon`, so the layout tests can't load a keymap. Installing it next." },
  { role: "system", text: "cursor-agent exited with code 1." },
];
transcript(port.id, portBlocks);
settle(port, portBlocks, "error", "cursor-agent exited with code 1");

const spikeBlocks = [
  started(spike, 33 * MIN),
  tool("Read", "Read vite.config.ts", { kind: "file", path: "vite.config.ts" }),
  tool("Edit", "Edit src/surfaces/chat/Message.tsx", { kind: "edit", path: "src/surfaces/chat/Message.tsx", added: 3, removed: 1 }, "interrupted"),
  { role: "system", text: "Stopped by Conductor. The session has exited; its transcript stays here." },
];
transcript(spike.id, spikeBlocks);
settle(spike, spikeBlocks, "exited", "stopped by Conductor");

const CHECKLIST = "Here's the order, one step at a time:\n\n1. `npm version minor`\n2. `git push --follow-tags`\n3. Wait for the notarize job\n4. Upload the DMG\n\nTell me when step 1 is done.";
const checklistBlocks = [received(conductor, JOBS.checklist, checklistLaunch, 32 * MIN, { letterKind: "started" }), { role: "assistant", text: CHECKLIST }];
transcript(checklist.id, checklistBlocks);
settle(checklist, checklistBlocks, "turn", "completed", { report: CHECKLIST });
sql.push(`UPDATE sessions SET user_seen = cursor WHERE id IN (${[flake, port, spike].map((c) => q(c.id)).join(", ")});`);

/** What a session left running in its background panel, as the board saved it. */
function background(sessionId, entries) {
  entries.forEach(({ output = null, ...entry }, position) => {
    sql.push(
      `INSERT INTO background_entries (session_id, position, id, entry_json, output, output_truncated) VALUES (${q(sessionId)}, ${position}, ${q(
        entry.id,
      )}, ${q(JSON.stringify(entry))}, ${output === null ? "NULL" : q(output)}, 0);`,
    );
  });
}
const VITE_LOG = ["", "  VITE v6.3.5  ready in 412 ms", "", "  ➜  Local:   http://localhost:5173/", ...Array.from({ length: 12 }, (_, i) => `${i % 2 ? "2:41:0" : "2:40:5"}${i % 10} [vite] hmr update /src/${["App.tsx", "index.css", "chrome/TabBar.tsx"][i % 3]}`)].join("\n");
background(conductor.id, [
  {
    id: "task-bundle",
    command: "Audit bundle size",
    description: "Find what makes the chat bundle 2.1 MB and what of it could load later.",
    kind: "subagent",
    startedAt: now - 31 * MIN,
    state: "running",
    toolCallId: backgroundTask.tool.callId,
    tokens: 48_210,
    window: 200_000,
    model: "claude-sonnet-5-5",
    activity: "Reading vite.config.ts",
    stoppable: true,
  },
  { id: "bg-dev", command: "npm run dev", description: "Dev server", kind: "shell", startedAt: now - 30 * MIN, state: "running", toolCallId: devServer.tool.callId, activity: "[vite] hmr update /src/App.tsx", stoppable: true, output: VITE_LOG },
  {
    id: "bg-vitest",
    command: `cd ${crewRepo} && npx vitest --watch src/lib/keymap.test.ts`,
    kind: "shell",
    startedAt: now - 29 * MIN,
    state: "running",
    toolCallId: vitest.tool.callId,
    activity: "✓ src/lib/keymap.test.ts (24 tests) 18ms",
    stoppable: true,
    output: " RUN  v3.2.4\n\n ✓ src/lib/keymap.test.ts (24 tests) 18ms\n\n Test Files  1 passed (1)\n      Tests  24 passed (24)\n\n Waiting for file changes...",
  },
  { id: "bg-monitor", command: "tail -f ~/.crew/logs/crewd.log | grep --line-buffered ERROR", description: "Watch crewd for errors", kind: "monitor", startedAt: now - 28 * MIN, state: "running", toolCallId: monitor.tool.callId, stoppable: true, output: "" },
  { id: "bg-tsc", command: "npx tsc --noEmit", description: "Type check", kind: "shell", startedAt: now - 18 * MIN, state: "completed", exitCode: 0, endedAt: now - 17 * MIN, toolCallId: typecheck.tool.callId, output: "" },
  {
    id: "bg-e2e",
    command: "npm run e2e -- --grep W1",
    kind: "shell",
    startedAt: now - 14 * MIN,
    state: "failed",
    exitCode: 1,
    endedAt: now - 11 * MIN,
    toolCallId: e2e.tool.callId,
    output: "Running 1 test using 1 worker\n  ✘ W1: a worktree is made, worked in, dirtied and removed (10.4s)\n    Error: git lists the new worktree: gave up after 10000ms\n  1 failed",
  },
  { id: "bg-storybook", command: "npm run storybook", description: "Storybook", kind: "shell", startedAt: now - 38 * MIN, state: "stopped", endedAt: now - 25 * MIN, stopNote: "its CLI exited", output: "storybook v8.6.4 started\n  Local: http://localhost:6006/" },
]);

// ---------- orchestration from a session: Payments migration ----------

const MIGRATION_JOBS = {
  schema: "Diff db/schema.sql against the ledger's schema and list every column that has no home yet.",
  backfill: "Write scripts/backfill-ledger.ts: copy invoices into ledger entries in batches of 500, resumable.",
};
const migrationLetters = {};
function delegateFrom(parent, c, prompt, ago) {
  const id = mail(parent, c, prompt, ago);
  migrationLetters[c.id] = { id, text: prompt };
  return [
    {
      ...tool("mcp__crew__delegate", `Delegate to ${c.name}`, { kind: "message", to: c.name, toId: c.id, toName: c.name, text: prompt, letterId: id, what: "start" }),
      ago,
    },
    { role: "system", text: `Delegated to subagent ${c.name} (${c.id})`, letter_id: id },
  ];
}
const migrationDev = tool("Bash", "API server", { kind: "command", command: "npm run api", output: "Command running in background with ID: bg-api" });
const migrationWatch = tool("Bash", "Run vitest --watch", { kind: "command", command: "npx vitest --watch src/billing", output: "Command running in background with ID: bg-billing-tests" });
const migrationTask = tool("Task", "Map invoice states", {
  kind: "agent",
  description: "Map invoice states",
  agentType: "Explore",
  prompt: "List every state an invoice can be in and where each is set.",
  background: true,
  state: "running",
  activity: "Searching src/billing",
});
const migratorBlocks = [
  { role: "user", text: "Move billing onto the new ledger. Split it up: one on the schema, one on the backfill, and keep the API and the billing tests running.", ago: 22 * MIN },
  { role: "reasoning", text: "Schema and backfill are independent: two subagents. I'll keep the API up and the tests watching while they work." },
  ...delegateFrom(payments, schemaCheck, MIGRATION_JOBS.schema, 21 * MIN),
  ...delegateFrom(payments, backfill, MIGRATION_JOBS.backfill, 20 * MIN),
  migrationDev,
  migrationWatch,
  migrationTask,
  { role: "assistant", text: "Both subagents are on it, the API is up and the billing tests are watching. I'll stitch their reports together when they land." },
];
transcript(payments.id, migratorBlocks);
for (const [c, blocks] of [
  [schemaCheck, [tool("Bash", "Run pg_dump --schema-only", { kind: "command", command: "pg_dump --schema-only billing", exitCode: 0, output: "CREATE TABLE invoices (…)" }), tool("Read", "Read db/ledger.sql", { kind: "file", path: "db/ledger.sql" }, "pending")]],
  [backfill, [tool("Write", "Write backfill-ledger.ts", { kind: "edit", path: "scripts/backfill-ledger.ts", added: 64 }), tool("Bash", "Run a dry run", { kind: "command", command: "npx tsx scripts/backfill-ledger.ts --dry-run" }, "pending")]],
]) {
  const letter = migrationLetters[c.id];
  transcript(c.id, [received(payments, letter.text, letter.id, 20 * MIN, { letterKind: "started", fromKind: "session" }), ...blocks]);
}
background(payments.id, [
  {
    id: "task-states",
    command: "Map invoice states",
    description: "List every state an invoice can be in and where each is set.",
    kind: "subagent",
    startedAt: now - 18 * MIN,
    state: "running",
    toolCallId: migrationTask.tool.callId,
    tokens: 21_400,
    window: 200_000,
    model: "claude-haiku-5-5",
    activity: "Searching src/billing",
    stoppable: true,
  },
  { id: "bg-api", command: "npm run api", description: "API server", kind: "shell", startedAt: now - 19 * MIN, state: "running", toolCallId: migrationDev.tool.callId, activity: "GET /invoices 200 12ms", stoppable: true, output: "api listening on :4000\nGET /health 200 1ms\nGET /invoices 200 12ms" },
  { id: "bg-billing-tests", command: "npx vitest --watch src/billing", kind: "shell", startedAt: now - 19 * MIN, state: "running", toolCallId: migrationWatch.tool.callId, activity: "✓ 42 tests", stoppable: true, output: " ✓ src/billing/ledger.test.ts (42 tests) 31ms\n\n Waiting for file changes..." },
]);

// Conductor asked for Tunnel; the user has not approved it yet.
sql.push(`UPDATE processes SET approved = 0, created_by = ${q(conductor.id)}, requested_by = ${q(conductor.id)} WHERE id = ${q(tunnel.id)};`);

// ---------- orchestration at volume, from a session: spendo's Ledger rewrite ----------

const rwChildren = [...Object.values(rw), csvParser, ofxParser];
for (const c of rwChildren) sql.push(`UPDATE sessions SET kind = 'child', parent_id = ${q(c.parentId)} WHERE id = ${q(c.id)};`);
for (const s of [prReview, qaPass]) sql.push(`UPDATE sessions SET launched_by = ${q(rewrite.id)} WHERE id = ${q(s.id)};`);

/** A session handing work over: the parent's rows, and the letter as the child's first block. */
function handOff(parent, c, prompt, ago, what = "start") {
  const id = mail(parent, c, prompt, ago, { fromKind: "session" });
  const [name, label, note] =
    what === "start"
      ? ["mcp__crew__delegate", `Delegate to ${c.name}`, `Delegated to subagent ${c.name} (${c.id})`]
      : ["mcp__crew__start_session", `Start ${c.name}`, `Started session ${c.name} (${c.id})`];
  return {
    out: [
      { ...tool(name, label, { kind: "message", to: c.name, toId: c.id, toName: c.name, text: prompt, letterId: id, what }), ago },
      { role: "system", text: note, letter_id: id },
    ],
    first: received(parent, prompt, id, ago, { letterKind: "started", fromKind: "session" }),
  };
}
/** A subagent's report, question or failure as its parent reads it. */
const reportTo = (c, parent, text, ago, kind = "report") =>
  received(c, text, mail(c, parent, text, ago, { kind, fromKind: "session" }), ago, { letterKind: kind, fromKind: "session" });
/** Two sessions writing to each other: the sender's row and the reader's block. */
function sessionSay(from, fromBlocks, to, toBlocks, text, ago, delivery) {
  const id = mail(from, to, text, ago, { fromKind: "session" });
  fromBlocks.push(sent(to, text, id, ago, delivery));
  toBlocks.push(received(from, text, id, ago, { fromKind: "session" }));
}
const at = (block, ago) => ({ ...block, ago });

const RW_JOBS = {
  schema: "List every column in app/ that holds money, its type and who writes it. Report a table; don't change anything.",
  importer: "Rebuild app/Import on the ledger: one ImportedStatement per file, one Entry pair per row. Split the parsers out to subagents if it helps.",
  rounding: "Transfers between CLP and USD accounts lose a cent one time in ~200. Find the line and propose the fix.",
  ui: "Budget bars read Transaction::sum today. Move them onto LedgerTotals and keep the colors as they are.",
  bench: "Benchmark the monthly summary on 1M entries, before and after the ledger. p50 and p99.",
  docs: "Write docs/ledger.md: what an entry is, how a transfer posts, how a budget reads it. One diagram.",
  cleanup: "Delete the v1 transactions API and everything only it uses. Keep the routes file compiling.",
  fixtures: "Generate a year of statements for five fake accounts in every format the importer reads.",
  csv: "Parse the five CSV dialects in tests/fixtures/csv into StatementRow. Dates and amounts are the hard part.",
  ofx: "Parse OFX 1.x (SGML) and 2.x (XML) into StatementRow. Same contract as the CSV parser.",
  review: "Review the ledger PR (#212) as a second pair of eyes. Block on anything that moves money wrong.",
  qa: "Click through budgets, transfers and the importer on the new ledger and tell the user what looks off.",
};
const hand = {
  schema: handOff(rewrite, rw.schema, RW_JOBS.schema, 50 * MIN),
  importer: handOff(rewrite, rw.importer, RW_JOBS.importer, 49 * MIN),
  rounding: handOff(rewrite, rw.rounding, RW_JOBS.rounding, 48 * MIN),
  ui: handOff(rewrite, rw.ui, RW_JOBS.ui, 47 * MIN),
  bench: handOff(rewrite, rw.bench, RW_JOBS.bench, 46 * MIN),
  docs: handOff(rewrite, rw.docs, RW_JOBS.docs, 45 * MIN),
  cleanup: handOff(rewrite, rw.cleanup, RW_JOBS.cleanup, 44 * MIN),
  fixtures: handOff(rewrite, rw.fixtures, RW_JOBS.fixtures, 43 * MIN),
  review: handOff(rewrite, prReview, RW_JOBS.review, 41 * MIN, "launch"),
  qa: handOff(rewrite, qaPass, RW_JOBS.qa, 40 * MIN, "launch"),
  csv: handOff(rw.importer, csvParser, RW_JOBS.csv, 42 * MIN),
  ofx: handOff(rw.importer, ofxParser, RW_JOBS.ofx, 41 * MIN),
};

const RW_PLAN = `## Ledger rewrite: who does what

| Subagent | Provider | Job |
| --- | --- | --- |
| Schema audit | codex | every money column, read-only |
| Importer | claude | the importer, with its own parsers |
| Rounding bug | codex | the lost cent on CLP ↔ USD |
| Budgets UI | cursor | bars on ledger totals |
| Perf bench | claude | the monthly summary, before and after |
| Docs | opencode | docs/ledger.md |
| Old API cleanup | claude | delete v1 |
| Fixtures | codex | a year of fake statements |

Two more as sessions of your own: **Review ledger PR** and **QA pass**. The server, the queue, Vite and the tests stay up in the background.`;
const SCHEMA_REPORT = `14 money columns, 3 of them **float**:

| Table | Column | Type | Written by |
| --- | --- | --- | --- |
| transactions | amount | decimal(14,2) | TransactionController |
| transfers | amount | **float** | TransferService |
| budgets | cap | decimal(14,2) | BudgetController |
| accounts | balance | **float** | a nightly job |
| imports | total | **float** | StatementImporter |

The three floats are where cents go missing.`;
const DOCS_REPORT = "docs/ledger.md is in: entries, postings, how a transfer posts twice, and a mermaid diagram of an import. 212 lines.";
const BENCH_FAIL = "Its turn failed: claude exited with code 1\nWhat it said last:\n\nThe bench database ran out of disk at 640k entries. I need a bigger volume or a smaller run.";
const QA_REPORT = "Budgets and transfers look right. The importer shows **Imported 0 rows** for OFX files although the rows land: the counter reads before the parser is done.";
const ROUNDING_ASK = "The cent is lost in TransferService::convert, which rounds before it multiplies. Fix it with bcmath, or move the column to integer minor units?";
const CSV_REPORT = "All five dialects parse. Santander writes `1.234,56`, BCI `1234.56`, and two put the sign in its own column. 61 tests, all green.";

const RW_TEST_LOG = [
  "   PASS  Tests\\Unit\\Ledger\\EntryTest",
  ...Array.from({ length: 24 }, (_, i) => `  ✓ ${["posts a transfer twice", "balances to zero", "rejects a one-sided entry", "converts CLP to USD", "reads a budget from totals", "imports a statement once"][i % 6]} ${i + 1}`),
  "",
  "  Tests:    212 passed (618 assertions)",
  "  Duration: 4.81s",
].join("\n");

const rwBg = {
  money: tool("Task", "Trace money flows", {
    kind: "agent",
    description: "Trace money flows",
    agentType: "Explore",
    prompt: "Trace every path that writes an amount, from request to row. Don't change code.",
    background: true,
    state: "running",
    activity: "Reading app/Services/TransferService.php",
  }),
  rows: tool("Task", "Count rows per account", { kind: "agent", description: "Count rows per account", agentType: "general-purpose", prompt: "How many transactions does each account have, and the biggest month?", background: true, state: "done" }),
  serve: tool("Bash", "App server", { kind: "command", command: "php artisan serve --port 8010", output: "Command running in background with ID: bg-serve" }),
  vite: tool("Bash", "Vite", { kind: "command", command: "npm run dev", output: "Command running in background with ID: bg-vite" }),
  queue: tool("Bash", "Queue worker", { kind: "command", command: "php artisan queue:work --tries=3", output: "Command running in background with ID: bg-queue" }),
  pest: tool("Bash", "Run pest --watch", { kind: "command", command: "vendor/bin/pest --watch tests/Unit/Ledger", output: "Command running in background with ID: bg-pest" }),
  log: tool("Monitor", "Watch the Laravel log", { kind: "command", command: "tail -f storage/logs/laravel.log | grep --line-buffered -E 'ERROR|CRITICAL'" }),
  composer: tool("Bash", "Install dependencies", { kind: "command", command: "composer install", exitCode: 0, output: "Generating optimized autoload files\n> @php artisan package:discover" }),
  migrate: tool("Bash", "Run migrate:fresh --seed", { kind: "command", command: "php artisan migrate:fresh --seed", exitCode: 1, output: "Command running in background with ID: bg-migrate" }),
  build: tool("Bash", "Build assets", { kind: "command", command: "npm run build", exitCode: 0, output: "Command running in background with ID: bg-build" }),
  schedule: tool("Bash", "Scheduler", { kind: "command", command: "php artisan schedule:work", output: "Command running in background with ID: bg-schedule" }),
};

// Recurring API, a session next door, writes in too (its side is below).
const HEADS_UP = "Heads up: recurring transactions post through `TransferService::convert` for foreign accounts. Ping me when the rounding fix lands.";
const headsUp = mail(apiSide, rewrite, HEADS_UP, 6 * MIN, { fromKind: "session" });
const steerFixtures = "Skip Itaú: its export is the same as BCI's. Spend the time on OFX 1.x instead, the importer needs those first.";
const fixturesBlocks = [hand.fixtures.first];
const rewriteBlocks = [
  { role: "user", text: "Rewrite the ledger on double-entry: importer, budgets, transfers, docs, the lot. Split it up as wide as it goes and keep everything running while they work.", ago: 58 * MIN },
  { role: "reasoning", text: "Eight independent pieces. Read enough first to cut them cleanly, then hand each one out and keep the dev stack up so the subagents can test against it." },
  tool("TodoWrite", "Todos", {
    kind: "todo",
    items: [
      { text: "Read the current model", status: "completed" },
      { text: "Hand out the eight jobs", status: "completed" },
      { text: "Fix the lost cent", status: "inProgress" },
      { text: "Importer on the ledger", status: "inProgress" },
      { text: "Budgets on ledger totals", status: "inProgress" },
      { text: "Benchmark", status: "pending" },
      { text: "Docs", status: "completed" },
      { text: "Delete v1", status: "pending" },
    ],
  }),
  ...["app/Models/Transaction.php", "app/Models/Transfer.php", "app/Models/Budget.php", "app/Models/Account.php", "app/Services/TransferService.php", "app/Import/StatementImporter.php", "routes/api.php"].map((path) =>
    tool("Read", `Read ${path}`, { kind: "file", path }),
  ),
  tool("Grep", "Search ->amount", { kind: "search", query: "->amount", matches: 87 }),
  tool("Grep", "Search float(", { kind: "search", query: "float(", matches: 6 }),
  tool("Grep", "Search Transaction::sum", { kind: "search", query: "Transaction::sum", matches: 14 }),
  tool("Bash", "Run git log", { kind: "command", command: "git log --oneline -8 -- app/Models", exitCode: 0, output: "c41e2a1 fix: round budget caps\n9b0f3d2 feat: biweekly budgets\n77aa0c1 feat: transfers between accounts" }),
  tool("Bash", "Run the tests", { kind: "command", command: "vendor/bin/pest", exitCode: 0, output: RW_TEST_LOG }),
  at({ role: "assistant", text: RW_PLAN, ...usage(188, 64_100, 2_480, 0.42) }, 51 * MIN),
  ...hand.schema.out,
  ...hand.importer.out,
  ...hand.rounding.out,
  ...hand.ui.out,
  ...hand.bench.out,
  ...hand.docs.out,
  ...hand.cleanup.out,
  ...hand.fixtures.out,
  ...hand.review.out,
  ...hand.qa.out,
  at(rwBg.composer, 39 * MIN),
  at(rwBg.serve, 38 * MIN),
  rwBg.vite,
  rwBg.queue,
  rwBg.pest,
  rwBg.log,
  rwBg.schedule,
  at(rwBg.money, 33 * MIN),
  { role: "assistant", text: "Eight subagents and two sessions are on it; the stack is up. I'll stitch their reports as they land." },
  reportTo(rw.schema, rewrite, SCHEMA_REPORT, 31 * MIN),
  at(rwBg.migrate, 30 * MIN),
  at(tool("mcp__crew__stop_session", "Stop Old API cleanup", { kind: "crew", verb: "stop_session", targets: [{ id: rw.cleanup.id, name: rw.cleanup.name, provider: "claude" }], count: 0 }), 24 * MIN),
  { role: "assistant", text: "Stopped the cleanup: the mobile app still calls `/v1/transactions`. That waits for the next release." },
  at(rwBg.rows, 22 * MIN),
  at(rwBg.build, 20 * MIN),
  at(reportTo(rw.docs, rewrite, DOCS_REPORT, 13 * MIN), 13 * MIN),
  at(reportTo(qaPass, rewrite, QA_REPORT, 11 * MIN), 11 * MIN),
  at(reportTo(rw.bench, rewrite, BENCH_FAIL, 9 * MIN), 9 * MIN),
  received(apiSide, HEADS_UP, headsUp, 6 * MIN, { fromKind: "session" }),
  at(reportTo(rw.rounding, rewrite, ROUNDING_ASK, 4 * MIN, "question"), 4 * MIN),
  at(tool("mcp__crew__read_session", "Read Importer", { kind: "crew", verb: "read_session", targets: [{ id: rw.importer.id, name: rw.importer.name, provider: "claude" }], count: 24 }), 3 * MIN),
];
{
  const id = mail(rewrite, rw.fixtures, steerFixtures, 2 * MIN, { fromKind: "session" });
  rewriteBlocks.push(sent(rw.fixtures, steerFixtures, id, 2 * MIN, "steered"));
  fixturesBlocks.push(
    at(tool("Bash", "Run the generator", { kind: "command", command: "php artisan fixtures:statements --accounts 5 --months 12", exitCode: 0, output: "santander.csv  bci.csv  itau.csv  chile.ofx  estado.csv\n60 files, 14,882 rows" }), 20 * MIN),
    received(rewrite, steerFixtures, id, 2 * MIN, { fromKind: "session" }),
    tool("Bash", "Generate OFX 1.x", { kind: "command", command: "php artisan fixtures:statements --format ofx1 --accounts 5 --months 12" }, "pending"),
  );
}
rewriteBlocks.push(at(tool("Edit", "Edit app/Services/TransferService.php", { kind: "edit", path: "app/Services/TransferService.php", added: 9, removed: 4 }, "pending"), MIN));
transcript(rewrite.id, rewriteBlocks);
transcript(rw.fixtures.id, fixturesBlocks);

const importerBlocks = [
  hand.importer.first,
  tool("Read", "Read StatementImporter.php", { kind: "file", path: "app/Import/StatementImporter.php" }),
  tool("Glob", "Find tests/fixtures/**", { kind: "search", query: "tests/fixtures/**", output: "tests/fixtures/csv/santander.csv\ntests/fixtures/csv/bci.csv\ntests/fixtures/ofx/chile-1x.ofx\ntests/fixtures/ofx/chile-2x.ofx" }),
  { role: "reasoning", text: "The parsers are independent of the posting logic. Two subagents on them, I keep the ImportedStatement and the posting." },
  ...hand.csv.out,
  ...hand.ofx.out,
  at(tool("Write", "Write ImportedStatement.php", { kind: "edit", path: "app/Import/ImportedStatement.php", added: 74 }), 38 * MIN),
  tool("Edit", "Edit StatementImporter.php", { kind: "edit", path: "app/Import/StatementImporter.php", added: 52, removed: 88 }),
  tool("Bash", "Run the importer tests", { kind: "command", command: "vendor/bin/pest tests/Unit/Import", exitCode: 1, output: "  ✗ posts each row as two entries\n  Expected 2 entries, got 0: no parser for .ofx" }, "failed"),
  { role: "assistant", text: "Expected: the posting waits on the OFX parser. Moving on to idempotency while it lands." },
  at(reportTo(csvParser, rw.importer, CSV_REPORT, 7 * MIN), 7 * MIN),
  tool("Bash", "Run the importer tests", { kind: "command", command: "vendor/bin/pest tests/Unit/Import --filter csv" }, "pending"),
];
transcript(rw.importer.id, importerBlocks);

const csvBlocks = [
  hand.csv.first,
  ...["santander", "bci", "itau", "chile", "estado"].map((bank) => tool("Read", `Read ${bank}.csv`, { kind: "file", path: `tests/fixtures/csv/${bank}.csv`, lineStart: 1, lineEnd: 5 })),
  tool("Write", "Write CsvParser.php", { kind: "edit", path: "app/Import/Parsers/CsvParser.php", added: 148 }),
  tool("Bash", "Run the parser tests", { kind: "command", command: "vendor/bin/pest tests/Unit/Import/CsvParserTest.php", exitCode: 0, output: "  Tests:    61 passed (190 assertions)" }),
  at({ role: "assistant", text: CSV_REPORT, ...usage(301, 41_800, 1_340, 0.0) }, 7 * MIN),
  { role: "system", text: "Turn ended" },
];
transcript(csvParser.id, csvBlocks);
settle(csvParser, csvBlocks, "turn", "completed", { report: CSV_REPORT });

transcript(ofxParser.id, [
  hand.ofx.first,
  tool("WebFetch", "Fetch the OFX 2.2 spec", { kind: "fetch", url: "https://www.financialdataexchange.org/ofx", title: "OFX Specification" }),
  tool("Read", "Read chile-1x.ofx", { kind: "file", path: "tests/fixtures/ofx/chile-1x.ofx", preview: "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n<OFX>\n<BANKMSGSRSV1>" }),
  tool("Write", "Write OfxParser.php", { kind: "edit", path: "app/Import/Parsers/OfxParser.php", added: 96 }),
  at(tool("Bash", "Run the parser tests", { kind: "command", command: "vendor/bin/pest tests/Unit/Import/OfxParserTest.php", exitCode: 1, output: "  ✗ reads an SGML tag without a closing tag\n  Tests:    1 failed, 17 passed" }, "failed"), 5 * MIN),
  tool("Edit", "Edit OfxParser.php", { kind: "edit", path: "app/Import/Parsers/OfxParser.php", added: 11, removed: 3 }, "pending"),
]);

const schemaBlocks = [
  hand.schema.first,
  tool("Grep", "Search decimal|float", { kind: "search", query: "decimal|float", matches: 21 }),
  ...["create_transactions_table", "create_transfers_table", "create_budgets_table", "create_accounts_table"].map((m) => tool("Read", `Read ${m}.php`, { kind: "file", path: `database/migrations/${m}.php` })),
  at({ role: "assistant", text: SCHEMA_REPORT, ...usage(122, 22_900, 640, 0.07) }, 31 * MIN),
  { role: "system", text: "Turn ended" },
];
transcript(rw.schema.id, schemaBlocks);
settle(rw.schema, schemaBlocks, "turn", "completed", { report: SCHEMA_REPORT });

const roundingBlocks = [
  hand.rounding.first,
  tool("Read", "Read TransferService.php", { kind: "file", path: "app/Services/TransferService.php", lineStart: 40, lineEnd: 72, preview: "$converted = round($amount, 2) * $rate;" }),
  tool("Bash", "Run a 10k transfer fuzz", { kind: "command", command: "php artisan tinker --execute 'TransferFuzz::run(10000)'", exitCode: 0, output: "10000 transfers, 49 off by 0.01, all CLP → USD" }),
  { role: "assistant", text: "Found it: `round()` runs before the multiply. Two fixes, and the choice changes the migration." },
  at({
    role: "question",
    text: "Rounding",
    question: {
      requestId: 21,
      questions: [
        {
          question: "How should transfers keep their cents?",
          header: "Money type",
          multiSelect: false,
          options: [
            { label: "bcmath strings", description: "Smallest change: convert with bcmul, keep decimal columns." },
            { label: "Integer minor units", description: "Store cents as bigint. A bigger migration, no rounding ever." },
          ],
        },
      ],
    },
  }, 4 * MIN),
];
transcript(rw.rounding.id, roundingBlocks);
settle(rw.rounding, roundingBlocks, "needs-input", "", { request: { kind: "question", questions: [{ question: "How should transfers keep their cents?" }] } });

transcript(rw.ui.id, [
  hand.ui.first,
  tool("Grep", "Search Transaction::sum", { kind: "search", query: "Transaction::sum", output: "resources/js/Pages/Budgets/Index.vue\nresources/js/Components/BudgetBar.vue\napp/Http/Controllers/BudgetController.php" }),
  tool("Read", "Read BudgetBar.vue", { kind: "file", path: "resources/js/Components/BudgetBar.vue" }),
  tool("Edit", "Edit BudgetController.php", { kind: "edit", path: "app/Http/Controllers/BudgetController.php", added: 14, removed: 9 }),
  tool("Edit", "Edit BudgetBar.vue", { kind: "edit", path: "resources/js/Components/BudgetBar.vue", added: 6, removed: 6 }),
  at(tool("Bash", "Take a screenshot", { kind: "command", command: "npx playwright screenshot http://127.0.0.1:8010/budgets budgets.png" }, "pending"), 2 * MIN),
]);

const benchBlocks = [
  hand.bench.first,
  tool("Bash", "Seed 1M entries", { kind: "command", command: "php artisan bench:seed --entries 1000000", exitCode: 1, output: "640,000 / 1,000,000\nSQLSTATE[HY000]: General error: 1114 The table 'entries' is full" }, "failed"),
  at({ role: "assistant", text: "The bench database ran out of disk at 640k entries. I need a bigger volume or a smaller run." }, 9 * MIN),
  { role: "system", text: "claude exited with code 1." },
];
transcript(rw.bench.id, benchBlocks);
settle(rw.bench, benchBlocks, "error", "claude exited with code 1");

const docsBlocks = [
  hand.docs.first,
  tool("Read", "Read README.md", { kind: "file", path: "README.md" }),
  tool("Write", "Write docs/ledger.md", { kind: "edit", path: "docs/ledger.md", added: 212 }),
  at({ role: "assistant", text: DOCS_REPORT, ...usage(96, 15_200, 3_100, 0.0) }, 13 * MIN),
  { role: "system", text: "Turn ended" },
];
transcript(rw.docs.id, docsBlocks);
settle(rw.docs, docsBlocks, "turn", "completed", { report: DOCS_REPORT });

const cleanupBlocks = [
  hand.cleanup.first,
  tool("Grep", "Search /v1/transactions", { kind: "search", query: "/v1/transactions", matches: 9 }),
  tool("Bash", "Delete the v1 controllers", { kind: "command", command: "git rm -r app/Http/Controllers/V1", exitCode: 0, output: "rm 'app/Http/Controllers/V1/TransactionController.php'\nrm 'app/Http/Controllers/V1/Resources.php'" }),
  tool("Edit", "Edit routes/api.php", { kind: "edit", path: "routes/api.php", added: 0, removed: 22 }, "interrupted"),
  at({ role: "system", text: "Stopped by Ledger rewrite. The session has exited; its transcript stays here." }, 24 * MIN),
];
transcript(rw.cleanup.id, cleanupBlocks);
settle(rw.cleanup, cleanupBlocks, "exited", "stopped by Ledger rewrite");

const reviewBlocks = [
  hand.review.first,
  tool("Bash", "Run gh pr diff 212", { kind: "command", command: "gh pr diff 212 --name-only", exitCode: 0, output: "app/Ledger/Entry.php\napp/Ledger/Posting.php\napp/Services/TransferService.php\ndatabase/migrations/2026_10_15_create_entries_table.php" }),
  tool("Read", "Read Posting.php", { kind: "file", path: "app/Ledger/Posting.php" }),
  tool("Read", "Read the entries migration", { kind: "file", path: "database/migrations/2026_10_15_create_entries_table.php" }),
  { role: "assistant", text: "Two blocking comments, one call is yours: the migration drops `transfers.amount` before the backfill copies it." },
  at({
    role: "question",
    text: "Review",
    question: {
      requestId: 5,
      questions: [
        {
          question: "The migration drops transfers.amount before the backfill reads it. How should the PR land?",
          header: "Migration",
          multiSelect: false,
          options: [
            { label: "Two deploys", description: "Add entries now, drop the column a release later." },
            { label: "One deploy", description: "Backfill inside the migration and drop it in the same step." },
          ],
        },
      ],
    },
  }, 2 * MIN),
];
transcript(prReview.id, reviewBlocks);
settle(prReview, reviewBlocks, "needs-input", "", { request: { kind: "question", questions: [{ question: "How should the PR land?" }] } });

const qaBlocks = [
  hand.qa.first,
  tool("mcp__chrome-devtools__navigate_page", "chrome-devtools · navigate page", { kind: "mcp", server: "chrome-devtools", tool: "navigate_page", input: '{\n  "url": "http://127.0.0.1:8010/budgets"\n}', output: "Navigated." }),
  tool("mcp__chrome-devtools__take_screenshot", "chrome-devtools · take screenshot", { kind: "mcp", server: "chrome-devtools", tool: "take_screenshot", input: "{}", output: "Saved budgets.png" }),
  tool("mcp__chrome-devtools__upload_file", "chrome-devtools · upload file", { kind: "mcp", server: "chrome-devtools", tool: "upload_file", input: '{\n  "filePath": "tests/fixtures/ofx/chile-2x.ofx"\n}', output: "Imported 0 rows" }),
  at({ role: "assistant", text: QA_REPORT, ...usage(240, 37_000, 900, 0.12) }, 11 * MIN),
];
transcript(qaPass.id, qaBlocks);
settle(qaPass, qaBlocks, "turn", "completed", { report: QA_REPORT });
sql.push(`UPDATE sessions SET user_seen = cursor WHERE id IN (${[rw.schema, rw.docs, rw.cleanup, csvParser].map((c) => q(c.id)).join(", ")});`);

const LARAVEL_LOG = Array.from({ length: 16 }, (_, i) => `[2026-10-15 11:${String(20 + i).padStart(2, "0")}:0${i % 10}] local.INFO: ${["GET /budgets", "POST /transfers", "GET /api/ledger/totals", "POST /imports"][i % 4]} ${[200, 201, 200, 422][i % 4]}`).join("\n");
background(rewrite.id, [
  { id: "task-money", command: "Trace money flows", description: "Trace every path that writes an amount.", kind: "subagent", startedAt: now - 33 * MIN, state: "running", toolCallId: rwBg.money.tool.callId, tokens: 88_400, window: 200_000, model: "claude-sonnet-5-5", activity: "Reading app/Services/TransferService.php", stoppable: true },
  { id: "task-rows", command: "Count rows per account", description: "Rows per account and the biggest month.", kind: "subagent", startedAt: now - 22 * MIN, state: "completed", endedAt: now - 19 * MIN, toolCallId: rwBg.rows.tool.callId, tokens: 12_300, window: 200_000, model: "claude-haiku-5-5" },
  { id: "bg-serve", command: "php artisan serve --port 8010", description: "App server", kind: "shell", startedAt: now - 38 * MIN, state: "running", toolCallId: rwBg.serve.tool.callId, activity: "GET /api/ledger/totals 200", stoppable: true, output: "   INFO  Server running on [http://127.0.0.1:8010].\n\n  2026-10-15 11:31:02 /budgets ........ ~ 41ms\n  2026-10-15 11:31:09 /api/ledger/totals ........ ~ 12ms" },
  { id: "bg-vite", command: "npm run dev", description: "Vite", kind: "shell", startedAt: now - 37 * MIN, state: "running", toolCallId: rwBg.vite.tool.callId, activity: "[vite] hmr update /resources/js/Components/BudgetBar.vue", stoppable: true, output: VITE_LOG },
  { id: "bg-queue", command: "php artisan queue:work --tries=3", description: "Queue worker", kind: "shell", startedAt: now - 36 * MIN, state: "running", toolCallId: rwBg.queue.tool.callId, activity: "App\\Jobs\\PostImportedStatement ... DONE", stoppable: true, output: "  2026-10-15 11:30:12 App\\Jobs\\PostImportedStatement ....... RUNNING\n  2026-10-15 11:30:13 App\\Jobs\\PostImportedStatement ....... 412ms DONE" },
  { id: "bg-pest", command: "vendor/bin/pest --watch tests/Unit/Ledger", kind: "shell", startedAt: now - 35 * MIN, state: "running", toolCallId: rwBg.pest.tool.callId, activity: "212 passed", stoppable: true, output: RW_TEST_LOG },
  { id: "bg-log", command: "tail -f storage/logs/laravel.log | grep --line-buffered -E 'ERROR|CRITICAL'", description: "Watch the Laravel log", kind: "monitor", startedAt: now - 34 * MIN, state: "running", toolCallId: rwBg.log.tool.callId, stoppable: true, output: LARAVEL_LOG },
  { id: "bg-schedule", command: "php artisan schedule:work", description: "Scheduler", kind: "shell", startedAt: now - 34 * MIN, state: "stopped", endedAt: now - 26 * MIN, toolCallId: rwBg.schedule.tool.callId, stopNote: "stopped by Ledger rewrite", output: "   INFO  Running scheduled tasks every minute." },
  { id: "bg-composer", command: "composer install", description: "Install dependencies", kind: "shell", startedAt: now - 39 * MIN, state: "completed", exitCode: 0, endedAt: now - 38 * MIN, toolCallId: rwBg.composer.tool.callId, output: "Generating optimized autoload files" },
  { id: "bg-migrate", command: "php artisan migrate:fresh --seed", kind: "shell", startedAt: now - 30 * MIN, state: "failed", exitCode: 1, endedAt: now - 29 * MIN, toolCallId: rwBg.migrate.tool.callId, output: "  2026_10_15_create_entries_table ........ 18ms DONE\n\n   Illuminate\\Database\\QueryException\n\n  SQLSTATE[23000]: Integrity constraint violation: 1048 Column 'amount_minor' cannot be null" },
  { id: "bg-build", command: "npm run build", description: "Build assets", kind: "shell", startedAt: now - 20 * MIN, state: "completed", exitCode: 0, endedAt: now - 19 * MIN, toolCallId: rwBg.build.tool.callId, output: "vite v6.3.5 building for production...\n✓ 412 modules transformed.\n✓ built in 6.21s" },
]);
background(rw.importer.id, [
  { id: "bg-import-watch", command: "vendor/bin/pest --watch tests/Unit/Import", kind: "shell", startedAt: now - 37 * MIN, state: "running", activity: "1 failed, 33 passed", stoppable: true, output: "  ✗ posts each row as two entries\n  Tests:    1 failed, 33 passed" },
]);

// ---------- sessions writing to each other: spendo's Recurring API and Recurring UI ----------

const apiBlocks = [{ role: "user", text: "Build the recurring transactions API. The Recurring UI session is doing the screens; agree the contract with it directly.", ago: 35 * MIN }];
const uiBlocks = [{ role: "user", text: "Build the recurring transactions screens. Recurring API owns the endpoints: ask it, not me, about the contract.", ago: 34 * MIN }];
apiBlocks.push(tool("Read", "Read routes/api.php", { kind: "file", path: "routes/api.php" }), at({ role: "assistant", text: "Drafting the contract before I write anything." }, 33 * MIN));
sessionSay(apiSide, apiBlocks, uiSide, uiBlocks, "Proposed contract:\n\n`GET /api/recurring` → `[{ id, accountId, amount, rule: { every: 'month', day: 5 }, nextOn }]`\n`POST /api/recurring` with the same shape minus id and nextOn.\n\nWorks for you?", 32 * MIN);
uiBlocks.push(tool("Read", "Read Pages/Transactions/Index.vue", { kind: "file", path: "resources/js/Pages/Transactions/Index.vue" }));
sessionSay(uiSide, uiBlocks, apiSide, apiBlocks, "Close. Two asks: `amount` as a string like the rest of the API, and a `label` so the list isn't a wall of numbers.", 29 * MIN, "queued");
sessionSay(apiSide, apiBlocks, uiSide, uiBlocks, "Both in. `rule.every` is `week | month | year`; `day` is weekday 1–7 for weeks, day of month otherwise.", 27 * MIN, "steered");
apiBlocks.push(
  tool("Write", "Write RecurringController.php", { kind: "edit", path: "app/Http/Controllers/RecurringController.php", added: 88 }),
  tool("Write", "Write the recurring migration", { kind: "edit", path: "database/migrations/2026_10_15_create_recurring_table.php", added: 31 }),
  tool("Bash", "Run the API tests", { kind: "command", command: "vendor/bin/pest tests/Feature/RecurringTest.php", exitCode: 0, output: "  Tests:    18 passed (52 assertions)" }),
);
sessionSay(apiSide, apiBlocks, uiSide, uiBlocks, "Endpoints are up on :8010 behind the usual token. Fixtures: three rules on account 1.", 16 * MIN);
uiBlocks.push(
  tool("Write", "Write RecurringList.vue", { kind: "edit", path: "resources/js/Components/RecurringList.vue", added: 120 }),
  tool("Bash", "Call GET /api/recurring", { kind: "command", command: "curl -s localhost:8010/api/recurring -H 'Authorization: Bearer $TOKEN' | jq '.[0]'", exitCode: 0, output: '{\n  "id": 1,\n  "label": "Rent",\n  "amount": "-450000",\n  "rule": { "every": "month", "day": 5 },\n  "nextOn": "2026-11-05"\n}' }),
);
sessionSay(uiSide, uiBlocks, apiSide, apiBlocks, "Rent on the 31st: does `nextOn` clamp to the 30th in November, or skip the month?", 8 * MIN);
sessionSay(apiSide, apiBlocks, uiSide, uiBlocks, "Clamps to the last day. I'll add a test for February.", 7 * MIN, "steered");
apiBlocks.push(sent(rewrite, HEADS_UP, headsUp, 6 * MIN));
uiBlocks.push(
  { role: "assistant", text: "The list and the form work against the real API. One product call before I build the edit flow." },
  at({
    role: "question",
    text: "Recurring",
    question: {
      requestId: 9,
      questions: [
        {
          question: "When someone edits a recurring transaction, what changes?",
          header: "Edits",
          multiSelect: false,
          options: [
            { label: "Future only", description: "Past posted transactions stay as they were." },
            { label: "Ask each time", description: "A dialog: this one, future ones, or all." },
          ],
        },
      ],
    },
  }, MIN),
);
apiBlocks.push(at(tool("Edit", "Edit RecurringTest.php", { kind: "edit", path: "tests/Feature/RecurringTest.php", added: 12 }, "pending"), 5 * MIN));
transcript(apiSide.id, apiBlocks);
transcript(uiSide.id, uiBlocks);

// ---------- bots writing to each other: orca's Atlas, Beacon and Comet ----------

const [atlas, beacon, comet] = ["Atlas", "Beacon", "Comet"].map((name) => sessions.find((s) => s.ws === "orca" && s.name === name));
const atlasBlocks = [{ role: "user", text: "Get the socket timeout fix landed today. Beacon owns the code, Comet runs the soak test.", ago: 50 * MIN }];
const beaconBlocks = [];
const cometBlocks = [];
const say = (from, fromBlocks, to, toBlocks, text, ago, delivery) => {
  const [out, inn] = letter(from, to, text, ago, delivery);
  fromBlocks.push(out);
  toBlocks.push(inn);
};
atlasBlocks.push({ role: "assistant", text: "Handing it out: Beacon on the fix, Comet on the soak.", ago: 49 * MIN });
say(atlas, atlasBlocks, beacon, beaconBlocks, "Can you take fix/socket-timeout? The CLI drops the daemon socket after 30 s idle. Make the timeout configurable and default it to 5 min.", 48 * MIN);
beaconBlocks.push({ role: "assistant", text: "Looking at how the CLI dials the socket.", ago: 47 * MIN }, tool("Read", "Read cli/main.go", { kind: "file", path: "cli/main.go", lineStart: 1, lineEnd: 50 }));
say(atlas, atlasBlocks, comet, cometBlocks, "Once Beacon pushes, soak fix/socket-timeout for 30 minutes and tell me what breaks.", 46 * MIN);
cometBlocks.push({ role: "assistant", text: "Waiting for Beacon's push.", ago: 45 * MIN });
say(beacon, beaconBlocks, atlas, atlasBlocks, "Question: should the keepalive ping go both ways, or only CLI → daemon? Both is safer but touches the daemon.", 40 * MIN, "queued");
say(atlas, atlasBlocks, beacon, beaconBlocks, "Only CLI → daemon for now. Keep the daemon untouched in this PR.", 39 * MIN, "steered");
beaconBlocks.push(
  tool("Edit", "Edit cli/main.go", { kind: "edit", path: "cli/main.go", added: 18, removed: 3 }),
  tool("Bash", "Run go test ./...", { kind: "command", command: "go test ./...", exitCode: 0, output: "ok  \torca/cli\t0.412s\nok  \torca/daemon\t1.093s" }),
  tool("Bash", "Run git push", { kind: "command", command: "git push origin fix/socket-timeout", exitCode: 0, output: "To github.com:crew/orca.git\n   9e1b2c4..a3f9c12  fix/socket-timeout -> fix/socket-timeout" }),
);
say(beacon, beaconBlocks, comet, cometBlocks, "Pushed a3f9c12 to fix/socket-timeout. Soak it for 30 min with --socket-timeout 5m.", 23 * MIN);
say(beacon, beaconBlocks, atlas, atlasBlocks, "Pushed a3f9c12: `--socket-timeout`, default 5m, a ping every 20 s. Comet is soaking it.", 22 * MIN, "queued");
cometBlocks.push(
  tool("Bash", "Run the soak test", { kind: "command", command: "go run ./cmd/soak --branch fix/socket-timeout --duration 30m", exitCode: 0, output: "30m0s  1,204 requests  0 drops  p99 41ms\nWARN keepalive ping logged at info: 90 lines" }),
);
say(comet, cometBlocks, beacon, beaconBlocks, "Soak passed, but `keepalive ping` logs at info every 20 s: 90 lines per half hour. Can you drop it to debug?", 6 * MIN, "steered");
say(comet, cometBlocks, atlas, atlasBlocks, "Soak done: 30 min, 1,204 requests, 0 drops. One nit: the ping floods the log at info. Beacon is on it.", 5 * MIN);
say(beacon, beaconBlocks, comet, cometBlocks, "Good catch, dropping it to debug now.", 4 * MIN);
atlasBlocks.push({ role: "assistant", text: "Merging fix/socket-timeout once the log level change is in.", ...usage(41, 18_300, 220, 0.06), ago: 3 * MIN });
cometBlocks.push({ role: "assistant", text: "Thanks. I'll re-run the soak on the new commit.", ago: 3 * MIN });
beaconBlocks.push({ ...tool("Edit", "Edit cli/main.go", { kind: "edit", path: "cli/main.go", added: 1, removed: 1 }, "pending"), ago: 2 * MIN });
transcript(atlas.id, atlasBlocks);
transcript(beacon.id, beaconBlocks);
transcript(comet.id, cometBlocks);
// Twenty letters in a row woke Comet without the user: it is paused until they write.
sql.push(`INSERT OR REPLACE INTO app_state (key, value) VALUES (${q(`auto_turns:${comet.id}`)}, '20');`);

// ---------- devbox, straight to its own database ----------

const remoteSql = [];
for (const s of remoteSessions) {
  const at = now - s.ago;
  remoteSql.push(`UPDATE sessions SET updated_at = ${at}, created_at = ${at - 2 * HOUR} WHERE id = ${q(s.id)};`);
}
transcript(
  deployer.id,
  [
    { role: "user", text: "Deploy main to staging and watch the error rate for ten minutes.", ago: 14 * MIN },
    tool("Bash", "Run make deploy", { kind: "command", command: "make deploy ENV=staging", exitCode: 0, output: "→ building api:4c1e9a0\n→ pushing to registry\n→ rolling 3/3 pods\n✓ staging is on 4c1e9a0" }),
    tool("Bash", "Run kubectl logs", { kind: "command", command: "kubectl logs -n staging deploy/api --since=5m | grep -c ERROR", exitCode: 0, output: "0" }),
    { role: "assistant", text: "Staging is on `4c1e9a0`. No errors in the first five minutes; watching the rest." },
    tool("Bash", "Run kubectl logs -f", { kind: "command", command: "kubectl logs -n staging deploy/api -f" }, "pending"),
  ],
  remoteSql,
);
transcript(
  migrator.id,
  [
    { role: "user", text: "Write the migration for invoice due dates.", ago: 8 * MIN },
    tool("Write", "Write 0008_invoice_due.sql", { kind: "edit", path: "migrations/0008_invoice_due.sql", added: 9, hunks: [{ before: "", after: "ALTER TABLE invoices ADD COLUMN due_at TIMESTAMPTZ;\nUPDATE invoices SET due_at = issued_at + interval '30 days';\n" }] }),
    {
      role: "approval",
      text: "Run psql",
      approval: { requestId: 4, name: "Bash", input: { command: "psql $STAGING_URL -f migrations/0008_invoice_due.sql" } },
    },
  ],
  remoteSql,
);
execFileSync("sqlite3", [join(machineDir, "crew.sqlite3")], { input: `PRAGMA trusted_schema = ON;\nBEGIN;\n${remoteSql.join("\n")}\nCOMMIT;\n` });

// What app-design.mjs brings up next to the app: devbox's crewd and the runs.
writeFileSync(join(DATA, "seed-live.json"), JSON.stringify(live, null, 2));

const runs = (statuses) =>
  JSON.stringify(
    statuses.map((status, i) => ({
      id: `run-${i}`,
      startedAt: now - (i + 1) * 24 * HOUR,
      finishedAt: status === "running" ? null : now - (i + 1) * 24 * HOUR + 4 * MIN,
      status,
      trigger: i === 2 ? "manual" : "schedule",
    })),
  );
sql.push(`UPDATE routines SET runs_json = ${q(runs(["ok", "ok", "skipped", "error", "ok"]))}, last_run_at = ${now - 24 * HOUR} WHERE id = ${q(digest.id)};`);
sql.push(`UPDATE routines SET runs_json = ${q(runs(["ok", "error", "ok"]))}, last_run_at = ${now - HOUR} WHERE id = ${q(sweep.id)};`);

execFileSync("sqlite3", [join(DATA, "crew.sqlite3")], { input: `PRAGMA trusted_schema = ON;\nBEGIN;\n${sql.join("\n")}\nCOMMIT;\n` });

console.log(`seeded ${Object.keys(workspaces).length} workspaces, ${sessions.length} sessions into ${DATA}`);
