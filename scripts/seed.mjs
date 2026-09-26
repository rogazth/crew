// Seeds a dev data set of its own: workspaces, worktrees with diffs, agents and
// sessions in every status, transcripts, routines and open tabs. The app then
// runs on it without touching `Crew Dev`.
//
//   node scripts/seed.mjs                  → ~/Library/Application Support/Crew Design
//   CREW_USER_DATA=/some/dir node scripts/seed.mjs
//   npm run app:design                     → seeds if empty, then opens the app on it
//
// Re-running wipes the directory and seeds it again. Build the daemon first:
// cargo build -p crewd.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function makeRepo(name, files) {
  const dir = join(REPOS, name);
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

const crewRepo = makeRepo("crew", {
  "README.md": "# Crew\n\nA desktop app for the coding agent CLIs you already pay for.\n",
  "src/App.tsx": lines(120, "// app line"),
  "src/chrome/TabBar.tsx": lines(80, "// tab line"),
  "src/lib/keymap.ts": lines(60, "// keymap line"),
  "src/index.css": lines(200, "/* css */"),
  "docs/ARCHITECTURE.md": "# Architecture\n\nTwo processes.\n",
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

const ws = new WebSocket(info.url);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
ws.send(JSON.stringify({ auth: info.token }));

let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (message) => {
  const parsed = JSON.parse(message.data);
  if (parsed.id === undefined || !pending.has(parsed.id)) return;
  const { resolve, reject } = pending.get(parsed.id);
  pending.delete(parsed.id);
  parsed.ok ? resolve(parsed.result) : reject(new Error(parsed.error));
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// ---------- workspaces, agents, sessions ----------

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
const lead = await session("crew", "agent", "Planner", {
  model: "claude-opus-5-5",
  description: "Breaks the design pass into tickets and hands them out.",
  status: "working",
  ago: 0,
});
const reviewer = await session("crew", "agent", "Reviewer", {
  provider: "codex",
  model: "gpt-5.5-codex",
  description: "Reviews every diff before it lands.",
  status: "needs-input",
  ago: 3 * MIN,
});
const scribe = await session("crew", "agent", "Scribe", {
  provider: "opencode",
  description: "Keeps the docs in step with the code.",
  status: "done",
  ago: 12 * MIN,
});
await session("crew", "agent", "Tester", { provider: "cursor", status: "error", ago: 40 * MIN, description: "Runs the e2e suite." });
await session("crew", "agent", "Archivist", { ago: 3 * 24 * HOUR, description: "Idle for days." });
await session("crew", "terminal", "claude — design tokens", { status: "working", ago: 0 });
await session("crew", "terminal", "codex — release notes", { provider: "codex", status: "done", ago: 25 * MIN });
await session("crew", "terminal", "opencode", { provider: "opencode", ago: 5 * HOUR });

const tabsAgent = await session("crew", "agent", "Indicator", {
  worktree: crewTrees.tabs,
  status: "working",
  description: "Explores tab status indicators.",
  ago: 0,
});
await session("crew", "agent", "Pixel", { worktree: crewTrees.tabs, provider: "codex", status: "needs-input", ago: 2 * MIN });
await session("crew", "terminal", "claude — tabs", { worktree: crewTrees.tabs, status: "done", ago: 8 * MIN });
await session("crew", "agent", "Keys", { worktree: crewTrees.keymap, provider: "cursor", status: "error", ago: 30 * MIN });
await session("crew", "terminal", "vitest --watch", { worktree: crewTrees.keymap, provider: "opencode", ago: 2 * HOUR });
await session("crew", "agent", "Sweeper", { worktree: crewTrees.kumo, status: "done", ago: 50 * MIN });
// crewTrees.avatars stays empty: a worktree with nobody in it.

// spendo — a quiet workspace with one thing waiting on you.
await session("spendo", "agent", "Ledger", { status: "needs-input", ago: 6 * MIN, description: "Imports bank statements." });
await session("spendo", "agent", "Budgeteer", { provider: "codex", ago: 26 * HOUR });
await session("spendo", "terminal", "php artisan test", { provider: "claude", ago: 3 * HOUR });
await session("spendo", "agent", "Biweekly", { worktree: spendoTrees.budgets, status: "working", ago: 0 });

// orca — lots of agents, to see the grid wrap and the folded faces stack.
for (const [i, name] of ["Atlas", "Beacon", "Comet", "Delta", "Echo", "Flint", "Gale"].entries()) {
  await session("orca", "agent", name, {
    provider: ["claude", "codex", "cursor", "opencode"][i % 4],
    status: ["idle", "working", "idle", "done", "idle", "idle", "error"][i],
    ago: i * 17 * MIN,
  });
}
await session("orca", "agent", "Handoff", { worktree: orcaTrees.a, status: "working" });
await session("orca", "agent", "Timeout", { worktree: orcaTrees.b, status: "needs-input", ago: MIN });
await session("orca", "terminal", "go test ./...", { worktree: orcaTrees.b, provider: "opencode", status: "done" });
await session("orca", "agent", "Commenter", { worktree: orcaTrees.c, ago: 4 * HOUR });
await session("orca", "agent", "A very long agent name that should truncate", { worktree: orcaTrees.c, provider: "codex", ago: 5 * HOUR });

// landing — one agent, nothing else. notes — empty.
await session("landing", "agent", "Copywriter", { provider: "opencode", ago: 2 * 24 * HOUR });

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
await routine(tabsAgent.id, "Nightly e2e", { kind: "cron", expression: "0 2 * * 1-5" });

// ---------- app state ----------

const sessionTab = (s) => ({ id: `session:${s.id}`, kind: "session", sessionId: s.id });
const crewSessions = sessions.filter((s) => s.ws === "crew" && s.worktree === null);
await rpc("state_set", {
  key: `tabs:${workspaces.crew.id}`,
  value: JSON.stringify({
    tabs: [
      ...crewSessions.slice(0, 6).map(sessionTab),
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
    activeId: `session:${tabsAgent.id}`,
  }),
});
await rpc("active_workspace_set", { id: workspaces.crew.id });
await rpc("state_set", { key: "sidebar:width", value: "300" });

ws.close();
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
function transcript(sessionId, blocks) {
  let at = now - blocks.length * MIN;
  blocks.forEach((block, pos) => {
    const { role, text = "", ago, ...extra } = block;
    at = ago !== undefined ? now - ago : at + MIN;
    sql.push(
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

transcript(scribe.id, [
  { role: "user", text: "The design pass landed. Update the README.", ago: 30 * MIN },
  {
    role: "user",
    text: "Heads up: the dev profile moved. `npm run app:design` now seeds its own data — please document it.\n\nThanks!",
    from_agent: { id: lead.id, name: "Planner" },
  },
  tool("Read", "Read README.md", { kind: "file", path: "README.md" }),
  tool("Edit", "Edit README.md", { kind: "edit", path: "README.md", added: 12, removed: 2 }),
  tool("Message", "Message Planner", { kind: "message", to: "Planner", text: "README updated with the design profile." }),
  { role: "assistant", text: "Done. `npm run app:design` is documented under **Development**, with the reseed flag.", ...usage(38, 9_100, 410, 0.05) },
]);

transcript(tabsAgent.id, [
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
