/**
 * In-memory stand-in for the daemon, so the chrome renders in a plain browser
 * (`CREW_MOCK=1 npm run dev`) where DevTools and screenshots work. Only the
 * shapes matter; nothing here persists.
 */
import { showStandIn } from "../../src/lib/client/registry";
import { defaultEffortOf, defaultModelOf } from "../../src/lib/providers";

type Row = Record<string, unknown>;
type Listener = (payload: unknown, env: string) => void;

const listeners = new Map<string, Set<Listener>>();
const streams = new Map<number, (bytes: Uint8Array) => void>();
const buffered = new Map<number, Uint8Array[]>();
const bufferedBytes = new Map<number, number>();
const closed = new Set<number>();
const BUFFER_MAX_BYTES = 256 * 1024;
let nextStream = 1;

/** `env` is the machine that sent it: this Mac, unless a stand-in remote's call caused it. */
function emit(event: string, payload: unknown, env = "local") {
  for (const listener of listeners.get(event) ?? []) listener(payload, env);
}

/** The machine the call being answered was sent to; handlers that care read it before any await. */
let envNow = "local";

function pushBytes(id: number, bytes: Uint8Array) {
  if (closed.has(id)) return;
  const handler = streams.get(id);
  if (handler) {
    handler(bytes);
    return;
  }
  const queue = buffered.get(id) ?? [];
  let size = bufferedBytes.get(id) ?? 0;
  while (queue.length > 0 && size + bytes.byteLength > BUFFER_MAX_BYTES) {
    const old = queue.shift();
    if (!old) break;
    size -= old.byteLength;
  }
  if (size + bytes.byteLength > BUFFER_MAX_BYTES) return;
  queue.push(bytes);
  buffered.set(id, queue);
  bufferedBytes.set(id, size + bytes.byteLength);
}

const now = Date.now();
const workspaces: Row[] = [
  { id: "w1", name: "crew", path: "/Users/me/Developer/experiments/crew", createdAt: now - 4e6 },
  { id: "w2", name: "storefront-api", path: "/Users/me/Developer/storefront/api", createdAt: now - 3e6 },
  { id: "w3", name: "ledger", path: "/Users/me/Developer/ledger", createdAt: now - 2e6 },
  { id: "w4", name: "dotfiles", path: "/Users/me/dotfiles", createdAt: now - 1e6 },
];
// `?first=1` is a fresh install: no projects, so the window lands in home.
if (typeof location !== "undefined" && new URLSearchParams(location.search).get("first") === "1") workspaces.length = 0;
const MOCK_WORKTREES = "/Users/me/.crew/worktrees";
const AVATARS = `${MOCK_WORKTREES}/crew/feat-avatars`;
const SOCKET_REPLAY = `${MOCK_WORKTREES}/crew/fix-socket-replay`;
const sessions: Row[] = [
  session("s1", "w1", "bot", "Planner", "claude", "claude-opus-5", "needs-input"),
  session("s2", "w1", "bot", "Reviewer", "codex", "gpt-5", "idle", AVATARS),
  session("s3", "w1", "terminal", "claude", "claude", "claude-sonnet-5", "working"),
  session("s4", "w1", "terminal", "claude 2", "claude", "claude-sonnet-5", "done", SOCKET_REPLAY),
  session("s5", "w2", "terminal", "claude", "claude", "", "idle"),
  session("s6", "w3", "bot", "Bookkeeper", "cursor", "cursor-grok-4.6", "idle"),
  session("s8", "w1", "bot", "Grok", "grok", "", "idle"),
  // Orchestration: Lead and the sessions it started, one it handed to the user.
  session("s7", "w1", "bot", "Lead", "claude", "claude-opus-5", "idle"),
  child("c1", "Auth refactor", "claude", "working", null, 0, `${MOCK_WORKTREES}/crew/feat-auth-refactor`),
  child("c2", "Billing tests", "codex", "idle", "report", 0),
  child("c3", "Docs pass", "claude", "idle", "report", 0),
  child("c4", "Lint sweep", "codex", "idle", "report", 0),
  child("c5", "Fix flaky e2e", "claude", "idle", "failed", 0),
  child("c6", "Schema check", "codex", "needs-input", "approval", 0),
  {
    ...session("h1", "w1", "terminal", "Payments migration", "claude", "claude-sonnet-5", "idle"),
    handedOffBy: "s7",
    handedOffByName: "Lead",
    cursor: 3,
    userSeen: 0,
    updatedAt: now - 6e4,
  },
];

/** A session Lead started and owns; `event` is its last one, unseen by the user. */
function child(id: string, name: string, provider: string, status: string, event: string | null, seen: number, worktree: string | null = null): Row {
  return {
    ...session(id, "w1", "child", name, provider, "", status, worktree),
    parentId: "s7",
    parentName: "Lead",
    cursor: 4,
    userSeen: seen,
    ...(event ? { lastEvent: { kind: event, at: now - 2e5, cursor: 4 } } : {}),
  };
}
const state = new Map<string, string>([["active_workspace_id", "w1"]]);

/**
 * The linked worktrees of each main checkout; the main one is derived on each
 * listing. Only crew starts with any, the way a real repo would.
 */
const worktrees = new Map<string, Row[]>([
  [
    "/Users/me/Developer/experiments/crew",
    [
      { path: AVATARS, branch: "feat/avatars", main: false, add: 412, del: 37, dirty: 3 },
      { path: SOCKET_REPLAY, branch: "fix/socket-replay", main: false, add: 18, del: 6, dirty: 0 },
    ],
  ],
]);

function worktreeList(path: string): Row[] {
  return [{ path, branch: "master", main: true, add: 24, del: 9, dirty: 2 }, ...(worktrees.get(path) ?? [])];
}

function worktreeAdd(path: string, branch: string): Row {
  const name = branch.trim();
  if (!name) throw new Error("Branch name is required");
  const trees = worktrees.get(path) ?? [];
  if (trees.some((tree) => tree.branch === name)) {
    throw new Error(`'${name}' is already checked out at '${trees.find((tree) => tree.branch === name)?.path}'`);
  }
  const repo = path.split("/").filter(Boolean).pop() ?? "repo";
  const row = {
    path: `${MOCK_WORKTREES}/${repo}/${name.replace(/[^A-Za-z0-9._-]/g, "-")}`,
    branch: name,
    main: false,
    add: 0,
    del: 0,
    dirty: 0,
  };
  worktrees.set(path, [...trees, row]);
  return row;
}

function worktreeRemove(path: string, force: boolean): void {
  if (worktrees.has(path) || workspaces.some((w) => w.path === path)) {
    throw new Error("The main checkout cannot be removed");
  }
  for (const [main, trees] of worktrees) {
    const tree = trees.find((t) => t.path === path);
    if (!tree) continue;
    if ((tree.dirty as number) > 0 && !force) throw new Error(`${path} has uncommitted changes`);
    worktrees.set(main, trees.filter((t) => t !== tree));
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (sessions[i]?.worktree === path) sessions.splice(i, 1);
    }
    return;
  }
  throw new Error(`${path} is not a git worktree`);
}

const routines: Row[] = [
  {
    id: "r1", sessionId: "s1", name: "Morning digest", enabled: true,
    prompt: "Check the open PRs and tell me which ones wait on me.",
    schedule: JSON.stringify({ kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }),
    lastRunAt: now - 8 * 3600e3, nextRunAt: now + 16 * 3600e3,
    runsJson: JSON.stringify([
      { id: "run2", startedAt: now - 8 * 3600e3, finishedAt: now - 8 * 3600e3 + 42e3, status: "ok", trigger: "schedule" },
      { id: "run1", startedAt: now - 32 * 3600e3, finishedAt: now - 32 * 3600e3 + 12e3, status: "error", trigger: "schedule" },
      { id: "run0", startedAt: now - 56 * 3600e3, finishedAt: now - 56 * 3600e3, status: "skipped", trigger: "schedule" },
    ]),
  },
  {
    id: "r2", sessionId: "s2", name: "Find critical bugs", enabled: true,
    prompt: "Inspect recent commits and identify critical correctness bugs that escaped review. Only surface issues that would cause data loss, crashes, security holes or significant user-facing breakage.",
    schedule: JSON.stringify({ kind: "interval", minutes: 180 }),
    lastRunAt: now - 2 * 3600e3, nextRunAt: now + 3600e3,
    runsJson: JSON.stringify([
      { id: "run3", startedAt: now - 2 * 3600e3, finishedAt: now - 2 * 3600e3 + 96e3, status: "error", trigger: "manual" },
    ]),
  },
  {
    id: "r3", sessionId: "s2", name: "Weekly dependency sweep", enabled: false,
    prompt: "Check for outdated dependencies and open one PR per safe upgrade.",
    schedule: JSON.stringify({ kind: "cron", expression: "0 7 * * 1" }),
    lastRunAt: null, nextRunAt: null, runsJson: "[]",
  },
  {
    id: "r4", sessionId: "s6", name: "Reconcile expenses", enabled: true,
    prompt: "Import yesterday's transactions and flag anything that does not match a budget category.",
    schedule: JSON.stringify({ kind: "daily", hour: 22, minute: 30, days: [] }),
    lastRunAt: now - 20 * 3600e3, nextRunAt: now + 4 * 3600e3, runsJson: "[]",
  },
];

/**
 * Browser history and tab stacks. The daemon normalizes in Rust and ranks by
 * host, title and frecency; `URL` and a substring match, newest first, are
 * enough to see the screens.
 */
const history = new Map<string, Row>();
const pages = new Map<string, Row>();

function historyKey(raw: string): { urlKey: string; url: URL } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  const path = url.pathname === "/" && !url.search ? "" : url.pathname;
  return { urlKey: `${url.protocol}//${url.host}${path}${url.search}`, url };
}

function visitHistory(raw: string, title: string, workspaceId: string | null, at: number) {
  const found = historyKey(raw);
  if (!found) return;
  const row = history.get(found.urlKey);
  history.set(found.urlKey, {
    urlKey: found.urlKey,
    url: found.url.href,
    host: found.url.hostname.replace(/^www\./, ""),
    title: title || (row?.title ?? ""),
    visitCount: ((row?.visitCount as number | undefined) ?? 0) + 1,
    lastVisitedAt: at,
    workspaceId,
  });
}

function historyRows(text: unknown): Row[] {
  const needle = String(text ?? "").trim().toLowerCase();
  return [...history.values()]
    .filter((row) => !needle || `${String(row.url)} ${String(row.title)}`.toLowerCase().includes(needle))
    .sort((a, b) => (b.lastVisitedAt as number) - (a.lastVisitedAt as number));
}

for (const [url, title, ago] of [
  ["https://github.com/crew-dev/crew/pulls", "Pull requests · crew-dev/crew", 5 * 60e3],
  ["https://docs.rs/tokio/latest/tokio/", "tokio - Rust", 3600e3],
  ["http://localhost:5173/", "Crew", 2 * 3600e3],
  ["https://www.electronjs.org/docs/latest/api/webview-tag", "<webview> Tag | Electron", 26 * 3600e3],
] as const) {
  visitHistory(url, title, "w1", now - ago);
}

function session(
  id: string,
  workspaceId: string,
  kind: string,
  name: string,
  provider: string,
  model: string,
  status: string,
  worktree: string | null = null,
): Row {
  return {
    id,
    workspaceId,
    kind,
    name,
    provider,
    // The daemon never hands back a session without a model or an effort.
    model: model || defaultModelOf(provider),
    effort: defaultEffortOf(provider, model || defaultModelOf(provider)),
    serviceTier: "",
    providerSessionId: null,
    description: "",
    notifications: true,
    autonomy: "ask",
    status,
    worktree,
    createdAt: now - 6e5,
    updatedAt: now - 3e5,
    cursor: 0,
    userSeen: 0,
  };
}

/** A party to a letter, as the daemon names it: kind absent for a bot. */
function party(id: string): Row {
  if (id === "" || id === "user") return { id: "", name: "You", kind: "user" };
  const row = sessions.find((s) => s.id === id);
  const kind = row?.kind === "bot" ? undefined : row?.kind === "terminal" ? "terminal" : "session";
  return { id, name: (row?.name as string | undefined) ?? id, ...(kind ? { kind } : {}) };
}

const AUTH_JOB = [
  "Refactor the session token refresh out of `auth/middleware.ts` into `auth/session.ts`.",
  "",
  "- Keep the public `refresh()` signature.",
  "- Add tests for the expired-token path.",
  "- Commit on your branch when the suite is green; do not push.",
].join("\n");
const BILLING_REPORT = [
  "## Billing tests",
  "",
  "Added 14 tests in `billing/invoice.test.ts`: proration (6), refunds (5), zero-amount (3).",
  "",
  "| Suite | Before | After |",
  "| --- | --- | --- |",
  "| invoice | 22 | 36 |",
  "",
  "One real bug: a refund on a prorated invoice rounds the wrong way. Left it failing and marked `it.fails`; not fixed, as asked.",
].join("\n");

/** The mailbox: Planner and Reviewer writing each other, one letter still waiting for Planner. */
const letters: Row[] = [
  ["l1", "s1", "s2", "message", "Review the avatar branch when you can: the upload path changed.", now - 5.4e5, "delivered"],
  ["l2", "s2", "s1", "message", "Done. Two notes on the resize step; the rest reads fine.", now - 4.8e5, "delivered"],
  ["l3", "user", "s2", "message", "Look at the cache headers too.", now - 4.2e5, "delivered"],
  ["l4", "s2", "s1", "message", "Cache headers are missing on /avatars. Want me to open a fix?", now - 6e4, "pending"],
  ["o1", "s7", "c1", "message", AUTH_JOB, now - 40 * 60e3, "delivered"],
  ["o2", "s7", "c2", "message", "Write the missing tests for `billing/invoice.ts`: proration, refunds and the zero-amount case. Do not commit.", now - 40 * 60e3 + 2e4, "delivered"],
  ["o3", "c2", "s7", "report", BILLING_REPORT, now - 25 * 60e3, "delivered"],
  ["o4", "user", "c1", "message", "Keep the old cookie name for one release so existing sessions survive the deploy.", now - 15 * 60e3, "delivered"],
  ["o5", "s7", "h1", "message", "Carry on the payments migration in its own worktree. The plan:\n\n1. Add `payments.v2` behind the flag.\n2. Backfill from `ledger_entries`.\n3. Flip reads, then writes.", now - 10 * 60e3, "delivered"],
  ["o6", "c1", "s7", "report", "Token refresh moved into `auth/session.ts`; the old cookie name stays for one release. Tests pass.", now - 2 * 60e3, "pending"],
].map(([id, from, to, kind, text, at, state]) => ({ id, from: party(from as string), to: party(to as string), kind, text, at, state }));

const letterKey = (row: Row) => ((row.from as Row).kind === "user" ? "user" : ((row.from as Row).id as string));

function threadPairs(sessionId: string): Row[] {
  const pairs = new Map<string, { last: Row; count: number }>();
  for (const letter of letters) {
    const from = letterKey(letter);
    const to = (letter.to as Row).id as string;
    const mine = sessions.find((s) => s.id === to)?.parentId === sessionId && from === "user";
    if (from !== sessionId && to !== sessionId && !mine) continue;
    const key = [from, to].sort().join("|");
    const entry = pairs.get(key);
    pairs.set(key, { last: !entry || (letter.at as number) >= (entry.last.at as number) ? letter : entry.last, count: (entry?.count ?? 0) + 1 });
  }
  return [...pairs.values()]
    .sort((a, b) => (b.last.at as number) - (a.last.at as number))
    .map(({ last, count }) => {
      const to = (last.to as Row).id as string;
      const from = letterKey(last);
      const involved = to === sessionId || from === sessionId;
      return {
        peer: involved ? (to === sessionId ? last.from : last.to) : last.from,
        ...(involved ? {} : { with: last.to }),
        last: { ...last, text: String(last.text).slice(0, 280) },
        count,
      };
    });
}

function threadMessages({ a, b, before, limit }: Row): Row {
  const [x, y] = [a, b].map((id) => (id === "" ? "user" : (id as string)));
  const all = letters.filter((letter) => {
    const from = letterKey(letter);
    const to = (letter.to as Row).id;
    return (from === x && to === y) || (from === y && to === x);
  });
  const end = before ? all.findIndex((letter) => letter.id === before) : all.length;
  const stop = end < 0 ? all.length : end;
  const start = Math.max(0, stop - ((limit as number | undefined) ?? 50));
  return { letters: all.slice(start, stop), more: start > 0 };
}

/** Each bot's rules (`r3`) and each workspace's (`w3`), as `crew_core::rules` keeps them. */
type MockRule = { id: string; body: string };
const botRules = new Map<string, MockRule[]>([
  [
    "s1",
    [
      { id: "r1", body: "Never push to master." },
      { id: "r2", body: "Run the tests before pushing." },
    ],
  ],
]);
const workspaceRules = new Map<string, MockRule[]>();
const workspaceDescriptions = new Map<string, string>();
let nextRule = 3;
function rulesOf(id: string) {
  return { rules: botRules.get(id) ?? [] };
}
/** The user's edit, by id, onto `kept`'s rules for `id`; new rules take `prefix`. */
function editRules(kept: Map<string, MockRule[]>, prefix: string, { id, add = [], edit = [], remove = [] }: Row) {
  const tidy = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
  const rules = (kept.get(String(id)) ?? [])
    .filter((rule) => !(remove as string[]).includes(rule.id))
    .map((rule) => {
      const changed = (edit as { id: string; body: string }[]).find((e) => e.id === rule.id);
      return changed ? { ...rule, body: tidy(changed.body) } : rule;
    });
  for (const body of add as string[]) if (tidy(body)) rules.push({ id: `${prefix}${nextRule++}`, body: tidy(body) });
  kept.set(String(id), rules);
}
function saveRules(row: Row) {
  editRules(botRules, "r", row);
  return rulesOf(String(row.id));
}
function profileOf(id: string) {
  return { description: workspaceDescriptions.get(id) ?? "", rules: workspaceRules.get(id) ?? [] };
}
function saveProfile(row: Row) {
  editRules(workspaceRules, "w", row);
  if (typeof row.description === "string") workspaceDescriptions.set(String(row.id), row.description.trim());
  return profileOf(String(row.id));
}

/**
 * Each workspace's icon, as `crew_core::workspace_icon` keeps it: what its repo
 * offers (drawn here, best first), the choice, and an upload, in memory.
 */
const svgIcon = (fill: string, glyph: string, wide = false) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wide ? 96 : 64} 64"><rect width="${wide ? 96 : 64}" height="64" rx="14" fill="${fill}"/><text x="50%" y="58%" font-family="system-ui" font-size="30" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle">${glyph}</text></svg>`,
  )}`;
const repoIcons = new Map<string, { path: string; image: string }[]>([
  [
    "w1",
    [
      { path: "public/favicon.svg", image: svgIcon("#4f46e5", "C") },
      { path: "src-tauri/icons/icon.png", image: svgIcon("#0ea5e9", "c") },
      { path: "public/logo.svg", image: svgIcon("#111827", "crew", true) },
    ],
  ],
  ["w2", [{ path: "public/favicon.ico", image: svgIcon("#16a34a", "S") }]],
]);
type MockIcon = { choice: "auto" | "repo" | "upload" | "initials"; path: string | null; uploaded: string | null };
const iconChoices = new Map<string, MockIcon>();
function iconOf({ id, choices, have }: Row) {
  const kept = iconChoices.get(String(id)) ?? { choice: "auto", path: null, uploaded: null };
  const found = repoIcons.get(String(id)) ?? [];
  const image =
    kept.choice === "initials"
      ? null
      : kept.choice === "upload" && kept.uploaded
        ? kept.uploaded
        : ((kept.choice === "repo" ? found.find((file) => file.path === kept.path) : undefined) ?? found[0])?.image ?? null;
  // As the daemon does: the image the window says it has comes back by its stamp alone.
  const stamp = image ? `${image.length}:${image.slice(-24)}` : null;
  return {
    choice: kept.choice,
    path: kept.choice === "repo" ? kept.path : null,
    image: stamp !== null && stamp === have ? null : image,
    stamp,
    found: choices ? found : [],
    uploaded: choices ? kept.uploaded : null,
  };
}
function setIcon({ id, choice, path, upload }: Row) {
  const before = iconChoices.get(String(id)) ?? { choice: "auto", path: null, uploaded: null };
  const sent = upload as { mime: string; data: string } | undefined;
  if (choice === "repo" && !(repoIcons.get(String(id)) ?? []).some((file) => file.path === path)) throw new Error("Pick an image in the repo");
  if (choice === "upload" && !sent && !before.uploaded) throw new Error("No image has been uploaded");
  iconChoices.set(String(id), {
    choice: choice as MockIcon["choice"],
    path: choice === "repo" ? String(path) : null,
    uploaded: sent ? `data:${sent.mime};base64,${sent.data}` : before.uploaded,
  });
  return iconOf({ id, choices: true });
}

/* ── The MCP Registry, live through Vite's /mcp-registry proxy ───────── */
// The daemon keeps its own copy (crates/crew-core/src/registry.rs); the mock
// reads the live registry, which sends no CORS headers, through vite.config.ts.

// The daemon's list (crates/crew-core/src/registry.rs FEATURED), in its order.
const FEATURED = [
  "com.notion/mcp",
  "app.linear/linear",
  "io.github.github/github-mcp-server",
  "com.atlassian/atlassian-mcp-server",
  "io.github.getsentry/sentry-mcp",
  "com.figma.mcp/mcp",
  "com.stripe/mcp",
  "com.supabase/mcp",
  "com.vercel/vercel-mcp",
  "com.cloudflare.mcp/mcp",
  "com.gitlab/mcp",
  "com.neon/mcp",
  "com.airtable/mcp",
  "com.monday/monday.com",
  "com.canva.mcp/mcp",
  "com.webflow/mcp",
  "com.zapier/mcp",
  "com.paypal.mcp/mcp",
  "co.huggingface/hf-mcp-server",
  "ai.exa/exa",
  "io.github.upstash/context7",
  "com.wix/mcp",
];
const REGISTRY = "/mcp-registry/v0.1/servers";

type RegistryIcon = { src: string; mimeType?: string; sizes?: string[] };
type RegistryEntry = {
  server: { name: string; title?: string; description?: string; icons?: RegistryIcon[]; remotes?: { type: string; url: string }[] };
  _meta?: Record<string, { status?: string; updatedAt?: string } | undefined>;
};

function registryHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const registrable = (host: string) => host.split(".").filter(Boolean).slice(-2).join(".");

/** The daemon's `to_row`: a remote, active server, or nothing. */
function registryRow(entry: RegistryEntry): Row | null {
  const official = entry._meta?.["io.modelcontextprotocol.registry/official"];
  if ((official?.status ?? "active") !== "active") return null;
  const { server } = entry;
  const remote = server.remotes?.find((r) => r.type === "streamable-http") ?? server.remotes?.[0];
  if (!remote) return null;
  const host = registrable(registryHost(remote.url));
  const namespace = server.name.split("/")[0] ?? "";
  const owner = namespace.startsWith("io.github.") ? namespace.slice("io.github.".length).toLowerCase() : null;
  const labels = namespace.split(".");
  const publisher = owner !== null ? host || "github.com" : labels.length >= 2 ? `${labels[1]}.${labels[0]}` : namespace;
  const label = host.split(".")[0] ?? "";
  const firstParty = owner !== null ? label.length >= 3 && (owner.includes(label) || label.includes(owner)) : host === publisher;
  const icons = server.icons ?? [];
  const icon =
    icons.find((i) => i.mimeType === "image/svg+xml") ??
    icons.find((i) => i.mimeType === "image/png" && i.sizes?.some((size) => parseInt(size, 10) >= 64)) ??
    icons[0];
  return {
    name: server.name,
    title: server.title?.trim() || null,
    description: server.description ?? "",
    publisher,
    remoteUrl: remote.url,
    iconUrl: icon?.src ?? null,
    firstParty,
    updatedAt: official?.updatedAt ?? "",
  };
}

let featuredRows: Promise<Row[]> | null = null;
/** Every registry row a search answered, so installing one by name finds its URL and icon. */
const registryRows = new Map<string, Row>();

async function registrySearch(text: string, limit: number): Promise<Row[]> {
  const q = text.trim();
  if (!q) {
    featuredRows ??= Promise.all(
      FEATURED.map((name) =>
        fetch(`${REGISTRY}/${encodeURIComponent(name)}/versions/latest`)
          .then((r) => (r.ok ? (r.json() as Promise<RegistryEntry>) : null))
          .then((entry) => (entry ? registryRow(entry) : null))
          .catch(() => null),
      ),
    ).then((rows) => rows.filter((row): row is Row => !!row));
    const rows = await featuredRows;
    for (const row of rows) registryRows.set(row.name as string, row);
    return rows.slice(0, limit);
  }
  const params = new URLSearchParams({ search: q, version: "latest", limit: "100" });
  const response = await fetch(`${REGISTRY}?${params}`);
  if (!response.ok) throw new Error(`registry ${response.status}`);
  const { servers } = (await response.json()) as { servers: RegistryEntry[] };
  const seen = new Set<string>();
  const rows = servers
    .map(registryRow)
    .filter((row): row is Row => !!row && !seen.has(row.name as string) && !!seen.add(row.name as string))
    .sort((a, b) => Number(b.firstParty) - Number(a.firstParty))
    .slice(0, limit);
  for (const row of rows) registryRows.set(row.name as string, row);
  return rows;
}

/* ── Crew's connectors and the vault, in memory ───────────────────────── */

type MockTool = { name: string; title: string | null; description: string; readOnly: boolean; destructive: boolean; tokens: number };
type MockAccount = {
  id: string;
  connectorId: string;
  label: string;
  identity: string | null;
  state: "pending" | "connected" | "expired" | "needs-scope" | "failed";
  error: string | null;
  /** The workspaces it is for; `null` is every one. */
  workspaces: string[] | null;
  tools: MockTool[];
  toolsOff: string[];
  createdAt: number;
};
type MockConnector = {
  id: string;
  name: string;
  registryName: string | null;
  url: string;
  iconUrl: string | null;
  description: string;
  publisher: string;
  refused: string | null;
  builtin: string | null;
  accounts: MockAccount[];
  createdAt: number;
};

/** Google's apps, as crewd lists its built-ins (`connectors/google.rs`, `gws.rs`). */
type MockBuiltin = { id: string; name: string; description: string; server: string; iconUrl: string; family: string; unavailable: string | null; tools: MockTool[] };
const googleTool = (name: string, description: string, tokens: number, kind: "read" | "write" | "destructive" = "write"): MockTool => ({
  name,
  title: null,
  description,
  readOnly: kind === "read",
  destructive: kind === "destructive",
  tokens,
});
const google = (id: string, name: string, server: string, icon: string, description: string, tools: MockTool[]): MockBuiltin => ({
  id: `google.${id}`,
  name,
  description,
  server,
  iconUrl: `https://ssl.gstatic.com/images/branding/product/2x/${icon}_2020q4_48dp.png`,
  family: "google",
  unavailable: null,
  tools,
});
const BUILTINS: MockBuiltin[] = [
  google("gmail", "Gmail", "gmail.googleapis.com", "gmail", "Search and read mail, draft and send messages, and sort threads with labels.", [
    googleTool("search_threads", "Search the mailbox with Gmail's search syntax.", 420, "read"),
    googleTool("read_thread", "Read a thread's messages and the text of each.", 310, "read"),
    googleTool("list_labels", "List the mailbox's labels.", 160, "read"),
    googleTool("create_draft", "Write a draft, new or as a reply.", 380),
    googleTool("send_message", "Send an email, new or as a reply.", 450, "destructive"),
    googleTool("modify_labels", "Add or remove labels on a thread.", 290),
    googleTool("trash_thread", "Move a thread to the trash.", 180, "destructive"),
  ]),
  google("drive", "Google Drive", "www.googleapis.com/drive", "drive", "Search, read and upload files, make folders, and share or trash files.", [
    googleTool("search_files", "Search Drive with its query syntax.", 400, "read"),
    googleTool("read_file", "Read a file's text.", 260, "read"),
    googleTool("list_folder", "List what a folder holds.", 210, "read"),
    googleTool("upload_file", "Make a file in Drive from text.", 340),
    googleTool("create_folder", "Make a folder.", 170),
    googleTool("share_file", "Share a file with someone.", 330, "destructive"),
    googleTool("trash_file", "Move a file or folder to the trash.", 160, "destructive"),
  ]),
  google("calendar", "Google Calendar", "www.googleapis.com/calendar", "calendar", "List events, find free time, and create, change or delete events.", [
    googleTool("list_events", "List a calendar's events in a range.", 380, "read"),
    googleTool("find_free_time", "Answer the busy blocks of calendars in a range.", 300, "read"),
    googleTool("create_event", "Add an event.", 460),
    googleTool("update_event", "Change an event.", 390),
    googleTool("delete_event", "Delete an event.", 170, "destructive"),
  ]),
  google("docs", "Google Docs", "docs.googleapis.com", "docs", "Read documents, create new ones, and edit their text.", [
    googleTool("read_document", "Read a document's title and text.", 240, "read"),
    googleTool("create_document", "Make a document.", 280),
    googleTool("edit_document", "Replace text throughout a document, and add text at its end.", 420),
  ]),
  google("sheets", "Google Sheets", "sheets.googleapis.com", "sheets", "Read and write ranges, list a spreadsheet's sheets, and create spreadsheets.", [
    googleTool("read_range", "Read a range's values.", 280, "read"),
    googleTool("list_sheets", "List a spreadsheet's sheets.", 190, "read"),
    googleTool("create_spreadsheet", "Make a spreadsheet.", 230),
    googleTool("write_range", "Write rows of values to a range.", 360),
    googleTool("clear_range", "Clear a range's values.", 170, "destructive"),
  ]),
];

// Linear is seeded, signed in, so an installed registry connector's page shows
// without a sign-in; remove it to see the page empty.
const linearTool = (name: string, description: string, tokens: number, extra: Partial<MockTool> = {}): MockTool => ({
  name,
  title: null,
  description,
  readOnly: false,
  destructive: false,
  tokens,
  ...extra,
});
const connectors: MockConnector[] = [
  {
    id: "connector-linear",
    name: "Linear",
    registryName: "app.linear/linear",
    url: "https://mcp.linear.app/mcp",
    iconUrl: null,
    description: "Issues, projects and cycles in Linear.",
    publisher: "linear.app",
    refused: null,
    builtin: null,
    createdAt: Date.now() - 86_400_000,
    accounts: [
      {
        id: "account-linear-1",
        connectorId: "connector-linear",
        label: "you@example.com",
        identity: "you@example.com",
        state: "connected",
        error: null,
        workspaces: null,
        tools: [
          linearTool("list_issues", "List issues in the user's Linear workspace. Filter by team, assignee, state or label.\nReturns up to 50.", 820, { readOnly: true }),
          linearTool("get_issue", "Retrieve a Linear issue by its ID, with comments and attachments.", 410, { readOnly: true }),
          linearTool("list_projects", "List projects in the workspace. Archived ones are left out unless asked.", 380, { readOnly: true }),
          linearTool("create_issue", "Create a new Linear issue. Title and team are required; the rest is optional.", 960),
          linearTool("update_issue", "Update an existing issue's title, description, state, assignee or labels.", 880),
          linearTool("create_comment", "Comment on an issue, in Markdown.", 340),
          linearTool("delete_issue", "Delete an issue. It moves to the trash for 30 days.", 260, { destructive: true }),
        ],
        toolsOff: ["delete_issue"],
        createdAt: Date.now() - 86_400_000,
      },
    ],
  },
];
/** Sign-ins started and not yet redeemed, by state. */
const signIns = new Map<string, { accountId: string; isNew: boolean; loginHint: string | null }>();
let connectorSeq = 0;
const IDENTITIES = ["you@example.com", "you@personal.example"];

const emitConnectors = () => emit("connectors", structuredClone(connectors));
const findAccount = (id: unknown) => connectors.flatMap((c) => c.accounts).find((a) => a.id === id);
function needAccount(id: unknown): MockAccount {
  const account = findAccount(id);
  if (!account) throw new Error("mock: no such account");
  return account;
}

/** A plausible tool list from the connector's name; a delete is destructive and starts off. */
function mockTools(connector: MockConnector): MockTool[] {
  const slug = connector.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
  const tool = (verb: string, what: string, extra: Partial<MockTool>, tokens: number): MockTool => ({
    name: `${slug}-${verb}`,
    title: null,
    description: `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${what} in ${connector.name}.`,
    readOnly: false,
    destructive: false,
    tokens,
    ...extra,
  });
  return [
    tool("search", "anything", { readOnly: true }, 420),
    tool("fetch", "one item", { readOnly: true }, 380),
    tool("create", "an item", {}, 760),
    tool("update", "an item", {}, 610),
    tool("delete", "an item", { destructive: true }, 260),
  ];
}

function addConnector({ registryName, builtin, url, name }: Row): MockConnector {
  const app = BUILTINS.find((b) => b.id === builtin);
  if (app) {
    const known = connectors.find((c) => c.builtin === app.id);
    if (known) return known;
    const connector: MockConnector = {
      id: `builtin:${app.id}`,
      name: app.name,
      registryName: null,
      url: `https://${app.server}`,
      iconUrl: app.iconUrl,
      description: app.description,
      publisher: "Built in",
      refused: null,
      builtin: app.id,
      accounts: [],
      createdAt: Date.now(),
    };
    connectors.push(connector);
    emitConnectors();
    return connector;
  }
  const known = connectors.find((c) => (registryName ? c.registryName === registryName : c.url === url));
  if (known) return known;
  let remote = typeof url === "string" ? url : "";
  let title = typeof name === "string" && name ? name : "";
  let publisher = registryHost(remote);
  let iconUrl: string | null = null;
  if (typeof registryName === "string") {
    const row = registryRows.get(registryName);
    remote = (row?.remoteUrl as string | undefined) ?? `https://mcp.${registryName.split("/")[0]?.split(".").reverse().join(".")}/mcp`;
    publisher = (row?.publisher as string | undefined) ?? registryHost(remote);
    iconUrl = (row?.iconUrl as string | null | undefined) ?? null;
    const label = ((row?.title as string | null | undefined) ?? "").replace(/\s+(MCP\s*Server|MCP)$/i, "").trim();
    const word = registryName.split("/")[0]?.split(".")[1] ?? registryName;
    title = label || word.charAt(0).toUpperCase() + word.slice(1);
  }
  const connector: MockConnector = {
    id: `connector-${++connectorSeq}`,
    name: title || publisher || "Connector",
    registryName: typeof registryName === "string" ? registryName : null,
    url: remote,
    iconUrl,
    description: "",
    publisher,
    refused: null,
    builtin: null,
    accounts: [],
    createdAt: Date.now(),
  };
  connectors.push(connector);
  emitConnectors();
  return connector;
}

function connectConnector({ connectorId, accountId, label, loginHint, workspaces }: Row) {
  const connector = connectors.find((c) => c.id === connectorId);
  if (!connector) throw new Error("mock: no such connector");
  // A server that refuses Crew's client, so the page's refusal shows.
  if (connector.registryName?.includes("figma-refused")) {
    connector.refused = "it registers no public clients";
    emitConnectors();
    throw new Error(`${connector.name} doesn’t let Crew sign in. Use it through a CLI’s own sign-in.`);
  }
  const state = `mock-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const others = connector.accounts.filter((a) => a.id !== accountId && a.state !== "pending");
  let account = accountId ? connector.accounts.find((a) => a.id === accountId) : undefined;
  const isNew = !account;
  if (!account) {
    account = {
      id: `account-${connector.id}-${connector.accounts.length + 1}-${Date.now().toString(36)}`,
      connectorId: connector.id,
      label: typeof label === "string" && label ? label : `Account ${others.length + 1}`,
      identity: null,
      state: "pending",
      error: null,
      workspaces: Array.isArray(workspaces) ? (workspaces as string[]) : null,
      tools: [],
      toolsOff: [],
      createdAt: Date.now(),
    };
    connector.accounts.push(account);
    emitConnectors();
  }
  signIns.set(state, { accountId: account.id, isNew, loginHint: typeof loginHint === "string" ? loginHint : null });
  const redirectUri = "http://127.0.0.1:53682/callback";
  return {
    state,
    authUrl: `${connector.url.replace(/\/mcp\/?$/, "")}/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    redirectUri,
    accountId: account.id,
    // Google's own picker shows the other accounts.
    incognito: others.length > 0 && !connector.builtin,
  };
}

function redeem({ state, url }: Row) {
  const pending = signIns.get(state as string);
  if (!pending || !String(url).includes(`state=${state as string}`)) throw new Error("mock: no sign-in for that state");
  signIns.delete(state as string);
  const account = needAccount(pending.accountId);
  const connector = connectors.find((c) => c.id === account.connectorId)!;
  if (account.state === "pending") {
    const app = BUILTINS.find((b) => b.id === connector.builtin);
    account.tools = app ? structuredClone(app.tools) : mockTools(connector);
    account.toolsOff = account.tools.filter((t) => t.destructive).map((t) => t.name);
    // A built-in signs in as the account picked ("Continue as"), else as the next one Google's picker would offer.
    const taken = new Set(connector.accounts.map((a) => a.identity));
    account.identity = app
      ? (pending.loginHint ?? IDENTITIES.find((i) => !taken.has(i)) ?? `you+${connector.accounts.length}@example.com`)
      : (IDENTITIES[connector.accounts.indexOf(account) % IDENTITIES.length] ?? null);
    // Still called "Account N", it takes who signed in as its name.
    if (account.identity && /^Account \d+$/.test(account.label)) account.label = account.identity;
  }
  account.state = "connected";
  account.error = null;
  emitConnectors();
  return structuredClone(account);
}

function cancelSignIn({ state }: Row) {
  const pending = signIns.get(state as string);
  signIns.delete(state as string);
  if (!pending?.isNew) return null;
  for (const connector of connectors) connector.accounts = connector.accounts.filter((a) => a.id !== pending.accountId);
  emitConnectors();
  return null;
}

/* ── The servers each provider CLI already has, on this machine ──────── */

type MockMcpState = "connected" | "pending" | "failed" | "needs_auth" | "disabled" | "unknown";
type MockServer = {
  provider: string;
  name: string;
  transport: string;
  target: string;
  scope: string | null;
  state: MockMcpState;
  error: string | null;
  tools: number | null;
  offInCrew: boolean;
  canSignIn: boolean;
  canRemove: boolean;
};
type MockInventory = { provider: string; installed: boolean; servers: MockServer[]; error: string | null; checkedAt: number | null; checking: boolean };

function mockServer(provider: string, name: string, transport: string, target: string, scope: string, state: MockMcpState, tools: number | null): MockServer {
  // A claude.ai connector is signed in at claude.ai; everything else that asks can be signed in from Crew.
  return { provider, name, transport, target, scope, state, error: null, tools: state === "connected" ? tools : null, offInCrew: false, canSignIn: scope !== "claude.ai", canRemove: scope === "user" };
}

/** How many tools each server lists once it is signed in. */
const MOCK_TOOLS: Record<string, number> = { context7: 2, "chrome-devtools": 26, "claude.ai Notion": 14, "plugin:figma:figma": 11, "figma-nerb": 11 };
const CONTEXT7 = "https://mcp.context7.com/mcp";
const FIGMA = "https://mcp.figma.com/mcp";
const DEVTOOLS = "npx -y chrome-devtools-mcp@latest";

const LINEAR = "https://mcp.linear.app/mcp";

const inventory: MockInventory[] = [
  {
    provider: "claude",
    installed: true,
    servers: [
      mockServer("claude", "context7", "http", CONTEXT7, "user", "connected", 2),
      mockServer("claude", "chrome-devtools", "stdio", DEVTOOLS, "user", "connected", 26),
      mockServer("claude", "claude.ai Notion", "claude.ai", "https://mcp.notion.com/mcp", "claude.ai", "connected", 14),
      mockServer("claude", "plugin:figma:figma", "http", FIGMA, "plugin", "needs_auth", null),
    ],
    error: null,
    checkedAt: now - 6e5,
    checking: false,
  },
  {
    provider: "codex",
    installed: true,
    servers: [
      mockServer("codex", "context7", "http", CONTEXT7, "user", "needs_auth", null),
      mockServer("codex", "figma-nerb", "http", FIGMA, "user", "needs_auth", null),
      mockServer("codex", "chrome-devtools", "stdio", DEVTOOLS, "user", "connected", 26),
    ],
    error: null,
    checkedAt: now - 6e5,
    checking: false,
  },
  {
    provider: "cursor",
    installed: true,
    servers: [
      mockServer("cursor", "context7", "http", CONTEXT7, "user", "connected", 2),
      mockServer("cursor", "figma-nerb", "http", FIGMA, "user", "needs_auth", null),
    ],
    error: null,
    checkedAt: now - 6e5,
    checking: false,
  },
  { provider: "grok", installed: true, servers: [], error: null, checkedAt: now - 6e5, checking: false },
  { provider: "opencode", installed: false, servers: [], error: null, checkedAt: now - 6e5, checking: false },
];
/** A remote beside this Mac, so Connectors shows servers from two machines. */
const STUDIO = "studio";
const studioInventory: MockInventory[] = [
  {
    provider: "claude",
    installed: true,
    servers: [
      mockServer("claude", "context7", "http", CONTEXT7, "user", "connected", 2),
      mockServer("claude", "linear", "http", LINEAR, "user", "needs_auth", null),
      mockServer("claude", "chrome-devtools", "stdio", DEVTOOLS, "user", "connected", 26),
    ],
    error: null,
    checkedAt: now - 3e5,
    checking: false,
  },
  {
    provider: "codex",
    installed: true,
    servers: [mockServer("codex", "linear", "http", LINEAR, "user", "connected", 22)],
    error: null,
    checkedAt: now - 3e5,
    checking: false,
  },
  {
    provider: "grok",
    installed: true,
    servers: [mockServer("grok", "context7", "http", CONTEXT7, "user", "connected", 2)],
    error: null,
    checkedAt: now - 3e5,
    checking: false,
  },
  { provider: "cursor", installed: false, servers: [], error: null, checkedAt: now - 3e5, checking: false },
  { provider: "opencode", installed: false, servers: [], error: null, checkedAt: now - 3e5, checking: false },
];
const inventories: Record<string, MockInventory[]> = { local: inventory, [STUDIO]: studioInventory };
const inventoryOf = (env: string) => inventories[env] ?? [];
// After the registry module has finished loading: it is imported above, and this module is one of its importers.
setTimeout(() => showStandIn({ id: STUDIO, name: "Studio", host: "100.64.0.7", port: 7456, user: "", ssh: "" }), 0);

/** Provider-server sign-ins started and not yet called back, by state. */
const serverSignIns = new Map<string, { env: string; provider: string; name: string }>();
/** Each live session's servers switched off at runtime (`mcp_toggle`). */
const toggledOff = new Map<string, Set<string>>();

const emitInventory = (env = "local") => emit("provider-servers", structuredClone(inventoryOf(env)), env);
function needServer({ provider, name }: Row, env = envNow): MockServer {
  const server = inventoryOf(env).find((i) => i.provider === provider)?.servers.find((x) => x.name === name);
  if (!server) throw new Error("mock: no such server");
  return server;
}

function listServers({ refresh }: Row) {
  const env = envNow;
  const list = inventoryOf(env);
  if (refresh) {
    for (const entry of list) if (entry.installed) entry.checking = true;
    setTimeout(() => {
      for (const entry of list) {
        entry.checking = false;
        entry.checkedAt = Date.now();
      }
      emitInventory(env);
    }, 900);
  }
  return structuredClone(list);
}

function signInServer(ref: Row) {
  const server = needServer(ref);
  const state = `mock-server-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  serverSignIns.set(state, { env: envNow, provider: server.provider, name: server.name });
  // Claude's sign-in comes back to Crew's own redirect; the other CLIs' to their own loopback listener.
  const redirectUri = server.provider === "claude" ? "http://127.0.0.1:17899/callback" : "http://127.0.0.1:60694/callback";
  const base = server.target.replace(/\/mcp\/?$/, "");
  return { kind: "browser", state, authUrl: `${base}/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`, redirectUri };
}

function serverCallback({ state, url }: Row) {
  const pending = serverSignIns.get(state as string);
  if (!pending || !String(url).includes(`state=${state as string}`)) throw new Error("mock: no sign-in for that state");
  serverSignIns.delete(state as string);
  const server = needServer(pending, pending.env);
  // The CLI starts the server again with its new credential: pending, then connected.
  server.state = "pending";
  server.error = null;
  emitInventory(pending.env);
  setTimeout(() => {
    server.state = "connected";
    server.tools = MOCK_TOOLS[server.name] ?? 4;
    emitInventory(pending.env);
  }, 700);
  return null;
}

/** A Claude session's servers, as `mcp_list` answers them: the CLI's, less what is off in Crew. */
function mcpStatus(sessionId: string) {
  const row = sessions.find((x) => x.id === sessionId);
  const provider = row?.provider as string | undefined;
  if (provider !== "claude") return { servers: [], reported: provider !== "cursor" && provider !== "grok" };
  const off = toggledOff.get(sessionId) ?? new Set<string>();
  const servers = (inventory.find((i) => i.provider === "claude")?.servers ?? [])
    .filter((x) => !x.offInCrew)
    .map((x) => ({ name: x.name, state: off.has(x.name) ? "disabled" : x.state }));
  return { servers, reported: true };
}

/** Plan usage with every pace on show: in reserve, on pace, spending ahead, spent, and no plan windows. */
function mockUsage() {
  const at = Date.now();
  const window = (id: string, label: string, usedPercent: number, windowMinutes: number, resetsIn: number) => ({
    id,
    label,
    usedPercent,
    windowMinutes,
    resetsAt: at + resetsIn * 60_000,
  });
  const reading = (provider: string, plan: string | undefined, windows: ReturnType<typeof window>[]) => ({
    provider,
    account: `${provider}@crew.dev`,
    plan,
    windows,
    updatedAt: at - 2 * 60_000,
    source: "cli",
  });
  return {
    readings: [
      reading("claude", "max", [window("five_hour", "5 hours", 5, 300, 235), window("seven_day", "Weekly", 70, 10080, 2 * 1440)]),
      reading("codex", "plus", [window("primary", "5 hours", 48, 300, 240), window("secondary", "Weekly", 100, 10080, 3 * 1440 + 300)]),
      reading("cursor", "premium", [window("weekly", "Weekly", 3, 10080, 6 * 1440)]),
      { ...reading("opencode", undefined, []), tokens: 20_400_000, cost: 1.25 },
    ],
    history: [
      ["claude", [12, 24, 31, 40, 52, 61, 70]],
      ["codex", [8, 30, 55, 70, 88, 100, 100]],
      ["cursor", [0, 0, 0, 0, 0, 1, 3]],
    ].flatMap(([provider, highs]) =>
      (highs as number[]).map((percent, index) => ({
        provider,
        account: `${provider}@crew.dev`,
        day: new Date(at - (6 - index) * 86_400_000).toISOString().slice(0, 10),
        percent,
      })),
    ),
  };
}

/** Crew's commands: two of the user's, one running in two worktrees, and one an agent wrote. */
function mockRun(worktree: string | null, state: string, startedBy: string | null, extra: Row = {}): Row {
  return {
    worktree,
    state,
    pid: state === "running" ? 4242 : null,
    streamId: null,
    startedAt: state === "running" ? now - 18 * 6e4 : null,
    exitCode: state === "exited" ? 1 : null,
    restarts: 0,
    ptyId: "",
    logCursor: 0,
    runCursor: 0,
    startedBy,
    env: {},
    url: null,
    ...extra,
  };
}
const processes: Row[] = [
  {
    id: "p1",
    workspaceId: "w1",
    name: "Dev server",
    command: "npm run dev",
    cwd: "",
    env: { PORT: "5173" },
    autoRestart: false,
    createdBy: null,
    revision: 1,
    runs: [
      mockRun(null, "running", null, { env: { PORT: "5173" }, url: "http://localhost:5173/" }),
      mockRun(AVATARS, "running", "s2", { env: { PORT: "5174" }, url: "http://localhost:5174/" }),
    ],
  },
  {
    id: "p2",
    workspaceId: "w1",
    name: "Daemon",
    command: "cargo run -p crewd -- --data-dir ./tmp/dev",
    cwd: "",
    env: {},
    autoRestart: true,
    createdBy: null,
    revision: 1,
    runs: [],
  },
  {
    id: "p3",
    workspaceId: "w1",
    name: "Storybook",
    command: "npx storybook dev -p 6006",
    cwd: "packages/ui",
    env: {},
    autoRestart: false,
    createdBy: "s1",
    revision: 1,
    runs: [mockRun(SOCKET_REPLAY, "exited", "s1")],
  },
  {
    id: "p4",
    workspaceId: "w1",
    name: "Type check",
    command: "npx tsc --noEmit --watch",
    cwd: "",
    env: {},
    autoRestart: false,
    createdBy: "s7",
    revision: 1,
    runs: [],
  },
];
function processChanged(row: Row): Row {
  emit("process-changed", row);
  return row;
}
function processRun(args: Row, state: string): Row {
  const row = processes.find((p) => p.id === args.id);
  if (!row) throw new Error("Process not found");
  const worktree = (args.worktree as string | undefined) ?? null;
  const runs = (row.runs as Row[]).filter((run) => run.worktree !== worktree);
  const run = mockRun(worktree, state, null, args.env ? { env: args.env } : {});
  row.runs = [...runs, run].sort((a, b) => (a.worktree === null ? -1 : b.worktree === null ? 1 : 0));
  return processChanged(row);
}

const commands: Record<string, (args: Row) => unknown> = {
  process_list: ({ workspaceId }) => processes.filter((p) => p.workspaceId === workspaceId),
  process_create: (args) => {
    const row = { cwd: "", env: {}, autoRestart: false, ...args, id: `p${Date.now()}`, createdBy: null, revision: 1, runs: [] };
    processes.push(row);
    return processChanged(row);
  },
  process_update: (args) => {
    const row = processes.find((p) => p.id === args.id);
    if (!row) throw new Error("Process not found");
    Object.assign(row, args, { revision: (row.revision as number) + 1 });
    return processChanged(row);
  },
  process_start: (args) => new Promise((resolve) => setTimeout(() => resolve(processRun(args, "running")), 600)),
  process_restart: (args) => processRun(args, "running"),
  process_stop: (args) => processRun(args, "stopped"),
  process_resume: (args) => processRun(args, "running"),
  process_delete: ({ workspaceId, id }) => {
    processes.splice(processes.findIndex((p) => p.id === id) >>> 0, 1);
    emit("process-removed", { workspaceId, id });
    return null;
  },
  process_reorder: () => undefined,
  process_log_tail: () => ({ text: "", start: 0, cursor: 0, skipped: 0 }),
  connectors_list: () => structuredClone(connectors),
  builtin_list: () => structuredClone(BUILTINS),
  // One machine, the vault: nothing else uses it in the mock.
  vault_status: () => ({
    holds: true,
    vaultName: null,
    vaultAddress: null,
    online: true,
    offlineSince: null,
    listening: null,
    machines: [],
    grants: connectors.flatMap((c) => c.accounts).filter((a) => a.state === "connected").length,
  }),
  vault_listen: () => null,
  vault_unlisten: () => null,
  connector_add: (args) => structuredClone(addConnector(args)),
  connector_remove: ({ connectorId }) => {
    const at = connectors.findIndex((c) => c.id === connectorId);
    if (at >= 0) connectors.splice(at, 1);
    emitConnectors();
    return null;
  },
  connector_connect: connectConnector,
  vault_callback: redeem,
  sign_in_cancel: cancelSignIn,
  provider_servers_list: listServers,
  provider_server_off: (args) => {
    const env = envNow;
    needServer(args).offInCrew = args.off === true;
    emitInventory(env);
    return null;
  },

  provider_server_remove: (args) => {
    const env = envNow;
    const gone = needServer(args);
    for (const entry of inventoryOf(env)) entry.servers = entry.servers.filter((x) => x !== gone);
    emitInventory(env);
    return null;
  },
  provider_server_sign_in: signInServer,
  provider_server_callback: serverCallback,
  provider_server_sign_in_cancel: ({ state }) => {
    serverSignIns.delete(state as string);
    return null;
  },
  mcp_list: ({ sessionId }) => mcpStatus(sessionId as string),
  mcp_toggle: ({ sessionId, name, enabled }) => {
    const off = toggledOff.get(sessionId as string) ?? new Set<string>();
    if (enabled) off.delete(name as string);
    else off.add(name as string);
    toggledOff.set(sessionId as string, off);
    const status = mcpStatus(sessionId as string);
    emit("mcp-changed", { sessionId, status });
    return status;
  },
  account_rename: ({ accountId, label }) => {
    needAccount(accountId).label = String(label);
    emitConnectors();
    return null;
  },
  account_remove: ({ accountId }) => {
    for (const connector of connectors) connector.accounts = connector.accounts.filter((a) => a.id !== accountId);
    emitConnectors();
    return null;
  },
  account_refresh: ({ accountId }) => {
    const account = needAccount(accountId);
    if (account.state === "failed") {
      account.state = "connected";
      account.error = null;
    }
    emitConnectors();
    return structuredClone(account);
  },
  account_workspaces_set: ({ accountId, workspaces }) => {
    const account = needAccount(accountId);
    account.workspaces = Array.isArray(workspaces) ? (workspaces as string[]) : null;
    emitConnectors();
    return null;
  },
  tool_set: ({ accountId, tool, on }) => {
    const account = needAccount(accountId);
    account.toolsOff = on ? account.toolsOff.filter((x) => x !== tool) : [...new Set([...account.toolsOff, tool as string])];
    emitConnectors();
    return null;
  },
  workspace_list: () => workspaces,
  workspace_home: () => {
    const found = workspaces.find((w) => w.home);
    if (found) return found;
    const row = { id: "home", name: "Home", path: "/Users/me/Crew", createdAt: now - 5e6, home: true };
    workspaces.unshift(row);
    return row;
  },
  workspace_create: ({ name, path }) => {
    const row = { id: `w${Date.now()}`, name, path, createdAt: Date.now() };
    workspaces.push(row);
    return row;
  },
  workspace_rename: ({ id, name }) => void Object.assign(workspaces.find((w) => w.id === id) ?? {}, { name }),
  workspace_delete: ({ id }) => {
    if (workspaces.find((w) => w.id === id)?.home) throw new Error("Home cannot be removed");
    void workspaces.splice(workspaces.findIndex((w) => w.id === id) >>> 0, 1);
  },
  workspace_reorder: () => undefined,
  active_workspace_get: () => state.get("active_workspace_id") ?? null,
  active_workspace_set: ({ id }) => void (id ? state.set("active_workspace_id", id as string) : state.delete("active_workspace_id")),
  session_list: ({ workspaceId }) => sessions.filter((s) => s.workspaceId === workspaceId),
  session_create: (args) => {
    const row = session(`s${Date.now()}`, args.workspaceId as string, args.kind as string, args.name as string, args.provider as string, args.model as string, "idle", (args.worktree as string | null | undefined) || null);
    Object.assign(row, {
      effort: (args.effort as string | undefined) || row.effort,
      serviceTier: (args.serviceTier as string | undefined) || row.serviceTier,
      autonomy: (args.autonomy as string | undefined) ?? "ask",
    });
    sessions.push(row);
    return row;
  },
  session_set_options: ({ id, model, effort, serviceTier, autonomy }) => {
    const row = sessions.find((s) => s.id === id);
    if (!row) return;
    Object.assign(row, {
      model: model || row.model,
      effort: effort || row.effort,
      serviceTier: serviceTier ?? row.serviceTier,
      autonomy,
    });
    emit("session-updated", { session: row });
  },
  session_get: ({ id }) => sessions.find((s) => s.id === id) ?? null,
  session_update: ({ id, ...rest }) => void Object.assign(sessions.find((s) => s.id === id) ?? {}, rest),
  bot_rules_get: ({ id }) => rulesOf(String(id)),
  bot_rules_save: saveRules,
  workspace_profile_get: ({ id }) => profileOf(String(id)),
  workspace_profile_save: saveProfile,
  workspace_icon_get: iconOf,
  workspace_icon_set: setIcon,
  bridge_info: () => ({ socketPath: "/mock/crew.sock", token: "mock", exe: "/mock/bin/crew" }),
  session_rename: ({ id, name }) => void Object.assign(sessions.find((s) => s.id === id) ?? {}, { name }),
  session_delete: ({ id }) => void sessions.splice(sessions.findIndex((s) => s.id === id) >>> 0, 1),
  session_is_disposable: () => false,
  session_reorder: () => undefined,
  session_set_status: ({ id, status }) => void Object.assign(sessions.find((s) => s.id === id) ?? {}, { status }),
  session_mark_seen: ({ id, cursor }) => {
    const row = sessions.find((s) => s.id === id);
    if (!row) return null;
    row.userSeen = Math.max(row.userSeen as number, (cursor as number | undefined) ?? (row.cursor as number));
    emit("session-updated", { session: row });
    return row;
  },
  // A terminal's conversation as its CLI wrote it: only the handoff has one.
  session_history_window: ({ id }) => ({ blocks: ORCHESTRATION[`history:${id as string}`] ?? [], start: 0, more: false, state: "ready" }),
  session_history_close: () => null,
  background_list: ({ sessionId }) => backgroundList(sessionId as string),
  background_output: ({ sessionId, id }) => backgroundOutput(sessionId as string, id as string),
  background_stop: ({ sessionId, id }) => backgroundStop(sessionId as string, id as string),
  thread_pairs: ({ sessionId }) => threadPairs(sessionId as string),
  thread_messages: (args) => threadMessages(args),
  mailbox_pending: ({ sessionId }) =>
    letters.filter((letter) => (letter.to as Row).id === sessionId && (letter.state === "pending" || letter.state === "claimed")),
  session_mark_read: ({ id }) =>
    void sessions.filter((s) => s.id === id && s.status === "done").forEach((s) => (s.status = "idle")),
  settings_list: () => [],
  settings_get: () => null,
  settings_set: ({ key, value, scope }) => ({ key, value, scope, revision: Date.now(), origin: "mock" }),
  settings_merge: () => [],
  state_get: ({ key }) => state.get(key as string) ?? null,
  usage_read: () => mockUsage(),
  state_set: ({ key, value }) => void state.set(key as string, value as string),
  state_delete: ({ key }) => void state.delete(key as string),
  worktree_list: ({ path }) => worktreeList(path as string),
  worktree_add: ({ path, branch }) => worktreeAdd(path as string, branch as string),
  worktree_remove: ({ path, force }) => worktreeRemove(path as string, Boolean(force)),
  list_project_files: () =>
    ["src/App.tsx", "src/main.tsx", "src/lib/tabs.ts", "README.md", "docs/mock.png"].map((relative) => ({
      name: relative.split("/").pop(),
      path: `/Users/me/Developer/experiments/crew/${relative}`,
      relative,
    })),
  list_folder: ({ path }) =>
    String(path).endsWith("/src")
      ? ["App.tsx", "main.tsx"].map((name) => ({ name, path: `${path}/${name}`, dir: false, ignored: false }))
      : [
          { name: "src", path: `${path}/src`, dir: true, ignored: false },
          { name: "node_modules", path: `${path}/node_modules`, dir: true, ignored: true },
          { name: "README.md", path: `${path}/README.md`, dir: false, ignored: false },
        ],
  search_files: ({ cwd, query }) => ({
    files: [
      {
        path: `${cwd}/src/App.tsx`,
        relative: "src/App.tsx",
        lines: [{ line: 3, preview: `export function App() { return "${query}"; }`, previewStart: 0, ranges: [[33, 33 + String(query).length]] }],
      },
    ],
    matches: 1,
    truncated: false,
    cancelled: false,
  }),
  read_text_file: ({ path }) =>
    String(path).endsWith(".md") ? MOCK_MARKDOWN : "export const answer = 42;\n",
  write_text_file: () => undefined,
  path_exists: () => false,
  path_is_file: () => false,
  read_file_base64: () => ({ mime: "image/png", data: MOCK_PNG }),
  write_temp_file: () => "/tmp/crew/mock.png",
  create_file_base64: () => undefined,
  pty_spawn: ({ id }) => {
    const streamId = nextStream++;
    mockShell(id as string, streamId);
    return streamId;
  },
  pty_write: () => undefined,
  pty_resize: () => undefined,
  pty_kill: ({ id }) => void emit("pty-exit", { id, code: 0 }),
  session_get_blocks: ({ id }) => JSON.stringify(thread(id as string).blocks),
  pty_ack: () => undefined,
  pty_attach: () => ({ start: 0, emitted: 0 }),
  agent_resolve_claude: () => ({ path: "/mock/bin/claude" }),
  agent_resolve: ({ name }) => ({ path: `/mock/bin/${name}` }),
  agent_installed: ({ names }) => names,
  // Grok's listing as `initialize` reports it: efforts per model, grok-4.5 without xhigh.
  agent_models: ({ provider }) =>
    provider === "grok"
      ? [
          { id: "grok-4.7", label: "Grok 4.7", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
          { id: "grok-4.7-build-fast", label: "Grok 4.7 Fast", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
          { id: "grok-4.6", label: "Grok 4.6", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
          { id: "grok-4.5", label: "Grok 4.5", efforts: ["low", "medium", "high"], defaultEffort: "high" },
        ]
      : [],
  session_provider_create: () => "mock-chat",
  session_provider_discover: () => null,
  session_claude_rebind: () => null,
  session_claude_attention: () => null,
  session_sync_title: () => null,
  transcript_tail: ({ sessionId, limit, beforePos }) => {
    const row = thread(sessionId as string);
    const before = (beforePos as number | undefined) ?? row.blocks.length + 1;
    const end = Math.max(0, Math.min(row.blocks.length, before - 1));
    const start = Math.max(0, end - ((limit as number | undefined) ?? 200));
    const blocks = row.blocks.slice(start, end);
    return {
      blocks,
      fromPos: blocks.length > 0 ? start + 1 : 0,
      toPos: blocks.length > 0 ? end : 0,
      more: start > 0,
      working: row.working,
      status: row.status,
      seq: row.seq,
    };
  },
  messages_search: (args) => search(args),
  turn_start: (args) => {
    const sessionId = args.sessionId as string;
    const row = thread(sessionId);
    row.blocks.push({
      id: `u${Date.now()}`,
      role: "user",
      text: args.text,
      at: Date.now(),
      ...(args.hidden ? { hidden: true } : {}),
      ...(args.files ? { files: args.files } : {}),
    });
    emitStatus(sessionId, "working");
    setTimeout(() => playTurn(sessionId), 200);
    return { working: true };
  },
  turn_stop: ({ sessionId }) => {
    const id = sessionId as string;
    emitApply(id, { type: "session.ended" });
    thread(id).blocks.push({ id: `sys${Date.now()}`, role: "system", text: "Stopped", at: Date.now() });
    emitStatus(id, "idle");
  },
  turn_respond: ({ sessionId, requestId, decision }) =>
    void mockRespond(sessionId as string, requestId as number, decision as string),
  turn_answer: ({ sessionId, requestId, answers }) =>
    void mockAnswer(sessionId as string, requestId as number, answers as Row | null),
  routine_list_for_session: ({ sessionId }) => routines.filter((r) => r.sessionId === sessionId),
  routine_list: () =>
    routines.flatMap((routine) => {
      const owner = sessions.find((s) => s.id === routine.sessionId);
      const workspace = workspaces.find((w) => w.id === owner?.workspaceId);
      return owner && workspace ? [{ routine, session: owner, cwd: workspace.path }] : [];
    }),
  routine_upsert: (args) => {
    const existing = routines.find((r) => r.id === args.id);
    if (existing) return Object.assign(existing, args);
    const row = { ...args, id: `r${Date.now()}`, lastRunAt: null, runsJson: "[]", createdBy: null };
    routines.push(row);
    return row;
  },
  routine_delete: ({ id }) => void routines.splice(routines.findIndex((r) => r.id === id) >>> 0, 1),
  /** The daemon fires routines; the mock just records that one ran. */
  routine_run_now: ({ routineId }) => {
    const routine = routines.find((r) => r.id === routineId);
    if (!routine) return undefined;
    const now = Date.now();
    const runs = JSON.parse((routine.runsJson as string) ?? "[]") as Row[];
    runs.unshift({ id: `run${now}`, startedAt: now, finishedAt: now, status: "ok", trigger: "manual" });
    Object.assign(routine, { lastRunAt: now, runsJson: JSON.stringify(runs.slice(0, 20)) });
    emit("routines-changed", {});
    return undefined;
  },
  browser_history_visit: ({ url, title, workspaceId }) =>
    void visitHistory(url as string, title as string, (workspaceId as string | undefined) ?? null, Date.now()),
  browser_history_title: ({ url, title }) => {
    const row = history.get(historyKey(url as string)?.urlKey ?? "");
    if (row && title) row.title = title;
  },
  browser_history_suggest: ({ text, limit }) => historyRows(text).slice(0, limit as number),
  browser_history_list: ({ text, before, limit }) =>
    historyRows(text)
      .filter((row) => before == null || (row.lastVisitedAt as number) < (before as number))
      .slice(0, limit as number),
  browser_history_delete: ({ urlKey }) => void history.delete(urlKey as string),
  browser_history_clear: ({ since }) => {
    for (const [key, row] of history) {
      if (since == null || (row.lastVisitedAt as number) >= (since as number)) history.delete(key);
    }
  },
  browser_page_save: ({ pageId, entriesJson, activeIndex }) =>
    void pages.set(pageId as string, { pageId, entriesJson, activeIndex, updatedAt: Date.now() }),
  browser_page_get: ({ pageId }) => pages.get(pageId as string) ?? null,
  browser_page_delete: ({ pageId }) => void pages.delete(pageId as string),
  registry_search: ({ text, limit }) => registrySearch(text as string, limit as number),
  registry_status: () => ({ servers: 32209, syncedAt: Date.now() - 20 * 60_000, syncing: false }),
  // The featured list stands in for the daemon's copy: a URL on a featured server's host is that server.
  registry_match: async ({ urls }) => {
    const featured = await registrySearch("", 50);
    const host = (url: string) => URL.canParse(url) ? new URL(url).host : "";
    return (urls as string[]).flatMap((url) => {
      const server = featured.find((x) => host(x.remoteUrl) === host(url));
      return server ? [{ url, server }] : [];
    });
  },
};

/** 160×100 gradient; any image the mock is asked for is this one. */
/** Every construct the markdown editor renders, so one screenshot shows them all. */
const MOCK_MARKDOWN = `---
title: Crew
tags: [app, agents]
aliases:
  - multi-agent
status: draft
---

# Crew

A **multi-agent** workspace with *live* terminals, \`inline code\` and ~~old ideas~~.
See [the docs](https://example.com/docs) or <https://example.com>.

## Getting started

- Clone the repo
- Run \`npm install\`
  - nested item
1. First
2. Second

- [x] Ship the browser
- [ ] Markdown preview

> Quotes read as a quieter voice.
> Across more than one line.

---

\`\`\`ts
export const answer = 42;
\`\`\`

| Name | Kind | Notes |
| ---- | :--: | ----: |
| crew | app  | **bold** and \`code\` |
| [[README]] | note | ==marked== |

## Links and callouts

Links to [[README]], [[README#Getting started|a heading]], and a [[Missing note]].

> [!note]
> A note callout with **bold** text.

> [!warning]- Folded by default
> Hidden until opened.
> Second line.

> [!tip] Tip with a title
> Use ==highlights== for what matters.

![[mock.png]]

## Diagram

\`\`\`mermaid
flowchart LR
  A[Agent] --> B{Tool?}
  B -- yes --> C[Run]
  B -- no --> D[Answer]
\`\`\`

## Deep section

### Third level

Final paragraph.
`;

const MOCK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAACCUlEQVR42u3R6ZYIBAAG0HmwkIpUUlGRQiEt1iK+MfuYlUKlosUuLbRY2lAqyWP5HsOPe859gzvwUO7VgvxfC3O3FuW/ejh3anH+rUfyTz2av+ux3K4l+auW5s96PLdqWW7WE7lRT+aPeiq/1/L8Vk/n11qRX+qZXK9nc62ey9VamSu1Kj/X8/mpXsiP9WJ+qNW5XGtyqV7K97U239XL+bZeyTe1Lhdrfb6uDblQr+Z8vZZztTFna1PO1OacrtdzqrbkZL2Rr+rNfFlv5Yt6O5/X1pyobTle2/NZ7cintTOf1K4cq3fycb2bj2p3Pqw9OVrv5UjtzeHalw8qeb8Gc6j252ANZb6GM1cjma3RzNRYpms8UzWRAzWZyTqQiZrKeE1nrGYyWrMZqbkM13yG6mD216EM1oBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWLBgwYIFCxYsWPCDF3wfzuPLZcrYMV4AAAAASUVORK5CYII=";

const SEED_BLOCKS = [
  { id: "b1", role: "user", at: now - 26 * 3600e3, text: "Find where the sidebar decides which sessions to show and tell me if the grouping is cached." },
  { id: "b2", role: "assistant", text: "Let me look at the sidebar first." },
  { id: "b3", role: "tool", text: "Read SessionSidebar.tsx", tool: { callId: "t1", name: "Read", title: "Read SessionSidebar.tsx", status: "completed" } },
  { id: "b4", role: "tool", text: "Grep groupSessions", tool: { callId: "t2", name: "Grep", title: "Grep groupSessions", status: "completed" } },
  { id: "b5", role: "tool", text: "Read sidebarPrefs.ts", tool: { callId: "t3", name: "Read", title: "Read sidebarPrefs.ts", status: "completed" } },
  { id: "b6", role: "tool", text: "Read useSidebarPrefs.ts", tool: { callId: "t4", name: "Read", title: "Read useSidebarPrefs.ts", status: "completed" } },
  { id: "b7", role: "assistant", text: "Grouping lives in `groupSessions` in `src/lib/sidebarPrefs.ts`, called from `SessionSidebar.tsx` inside a `useMemo` keyed on sessions, prefs and the query. So it is cached per render input, not across renders of unrelated state.\n\nOne thing worth fixing: `shows(prefs, key)` does an array lookup per row, which react-doctor already flags:\n\n```ts\nexport function shows(prefs: SidebarPrefs, key: string): boolean {\n  return !prefs.hidden.includes(key);\n}\n```\n\nThe Laravel side has the same shape in `app/Services/BookingService.php`:\n\n```php\nclass BookingService\n{\n    public function confirm(Booking $booking): void\n    {\n        $booking->update(['status' => BookingStatus::Confirmed]);\n        event(new BookingConfirmed($booking));\n    }\n}\n```\n\n## What I would change\n\n1. Build the hidden set once per prefs object, **not per row**.\n2. Keep `groupSessions` pure so the memo stays honest.\n   - A `WeakMap` keyed on prefs avoids a second cache.\n\n> react-doctor: *array lookup inside a render loop* (`sidebarPrefs.ts:41`)\n\n| Call | Rows | Cost |\n| --- | --- | --- |\n| `shows` | 120 | O(n) each |\n| `hiddenSet` | 1 | O(n) once |\n\nSee the [react-doctor rule](https://react-doctor.dev/rules/array-lookup) for the rationale.", usage: { inputTokens: 14200, outputTokens: 310, costUsd: 0.031, durationMs: 9400 }, at: now - 26 * 3600e3 + 9400 },
  { id: "b7a", role: "user", at: now - 25 * 3600e3, text: "Show me every markdown construct you can render." },
  { id: "b7b", role: "assistant", text: "# Kitchen sink de Markdown\n\n## Encabezados\n\n### H3\n\n#### H4\n\n## Texto\n\n**negrita**, *cursiva*, ***ambas***, ~~tachado~~, `inline code`, texto normal con [un link](https://example.com) y otro [con t\u00edtulo](https://example.com \"t\u00edtulo\").\n\n## Enlaces\n\nEnlace con t\u00edtulo: [Cursor](https://cursor.com)\n\nEnlace de referencia: [documentaci\u00f3n](https://github.com/anthropics/claude-code)\n\nAutolink: https://github.com\n\n## Listas\n\n1. Primer paso\n2. Segundo paso\n   1. Sub-paso anidado\n   2. Otro sub-paso\n3. Tercer paso\n\n- Item suelto\n- Otro item\n  - Nested\n    - Doble nested\n\n## Checkboxes\n\n- [x] Renderiza headers\n- [x] Renderiza listas\n- [ ] Renderiza tablas\n- [ ] Renderiza blockquotes anidados\n\n## Tabla\n\n| Feature | Soportado | Notas |\n|---|:---:|---|\n| Bold/Italic | \u2705 | b\u00e1sico |\n| Tablas | \u2753 | probando ahora |\n\n## Quote\n\n> Esto es una cita simple.\n>\n> > Y esto es una cita anidada dentro de otra.\n\n## C\u00f3digo\n\nInline: `const x = 42`\n\n```ts\nfunction greet(name: string): string {\n  return `Hola, ${name}!`;\n}\n```\n\n## Diff-style\n\n```diff\n- const old = true;\n+ const new = true;\n  function unchanged() {}\n```\n\n## Definici\u00f3n (glosario)\n\nRenderer\n: Componente que convierte Markdown en UI nativa.\n\nCustom renderer\n: Implementaci\u00f3n propia, no la del navegador.\n", usage: { inputTokens: 900, outputTokens: 520, costUsd: 0.012, durationMs: 6100 }, at: now - 25 * 3600e3 + 6100 },
  { id: "b8", role: "user", at: now - 4 * 60e3, text: "Fix it and run the linter.", files: [{ name: "sidebarPrefs.ts", path: "/Users/me/Developer/experiments/crew/src/lib/sidebarPrefs.ts", kind: "file" }, { name: "sidebar-before.png", path: "/Users/me/Desktop/sidebar-before.png", kind: "image", size: 48213 }, { name: "sidebar-after.png", path: "/Users/me/Desktop/sidebar-after.png", kind: "image", size: 51044 }] },
  { id: "b9", role: "reasoning", text: "The user wants the lookup fixed and the linter run. The Set can be built per prefs object; a WeakMap would keep it stable across rows." },
  { id: "b10", role: "tool", text: "Edit sidebarPrefs.ts", tool: { callId: "t5", name: "Edit", title: "Edit sidebarPrefs.ts", status: "completed" } },
  { id: "b11", role: "approval", text: "npm run lint", approval: { requestId: 1, name: "Bash", input: { command: "npm run lint" } } },
  {
    id: "b12",
    role: "user",
    at: now - 3 * 60e3,
    text: "The sidebar grouping is fixed on my side. Can you run the suite before I open the MR?",
    fromBot: { id: "s2", name: "Reviewer" },
  },
  {
    id: "b13",
    role: "tool",
    text: "npm run lint",
    tool: {
      callId: "t6",
      name: "Bash",
      title: "npm run lint",
      status: "completed",
      detail: { kind: "command", command: "npm run lint", exitCode: 0, output: "> crew@0.1.0 lint\n> eslint src\n\n19 problems (0 errors, 19 warnings)" },
    },
  },
  {
    id: "b14",
    role: "tool",
    text: "npm test",
    tool: {
      callId: "t7",
      name: "Bash",
      title: "npm test",
      status: "failed",
      detail: {
        kind: "command",
        command: "npm test -- sidebarPrefs",
        exitCode: 1,
        output: "FAIL  src/lib/sidebarPrefs.test.ts\n  × hides a session the user collapsed\n    expected true to be false\n\nTests  1 failed | 11 passed",
      },
    },
  },
  {
    id: "b15",
    role: "tool",
    text: "Read sidebarPrefs.ts",
    tool: {
      callId: "t8",
      name: "Read",
      title: "Read sidebarPrefs.ts",
      status: "completed",
      detail: {
        kind: "file",
        path: "/Users/me/Developer/crew/src/lib/sidebarPrefs.ts",
        lineStart: 38,
        lineEnd: 44,
        preview: "export function shows(prefs: SidebarPrefs, key: string): boolean {\n  return !hiddenSet(prefs).has(key);\n}",
      },
    },
  },
  {
    id: "b16",
    role: "tool",
    text: "Edit sidebarPrefs.ts",
    tool: {
      callId: "t9",
      name: "Edit",
      title: "Edit sidebarPrefs.ts",
      status: "completed",
      detail: { kind: "edit", path: "src/lib/sidebarPrefs.ts", added: 6, removed: 2 },
    },
  },
  {
    id: "b17",
    role: "tool",
    text: "Crew message agent Reviewer",
    tool: {
      callId: "t10",
      name: "mcp__crew__message_agent",
      title: "Crew message agent Reviewer",
      status: "completed",
      detail: {
        kind: "message",
        to: "Reviewer",
        text: "Suite is green after the fix: one test was asserting the old lookup. Lint has 19 warnings, all pre-existing. Go ahead with the MR.",
      },
    },
  },
  {
    id: "b18",
    role: "assistant",
    at: now - 60e3,
    text: "Green. One test was pinned to the old lookup, so I updated it with the fix and told Reviewer to open the MR.",
    usage: { inputTokens: 18400, outputTokens: 180, costUsd: 0.024, durationMs: 21600 },
  },
];

/** FTS5 in a browser is not worth faking; substring over the seed is enough to
 *  see the screen. The marks are the daemon's, so the UI paints the same runs. */
function search(args: Row): Row[] {
  const query = String(args.query ?? "").trim().toLowerCase();
  if (!query) return [];
  const only = (args.sessionIds as string[] | undefined) ?? [];
  const from = args.from as number | undefined;
  const hits: Row[] = [];
  for (const session of sessions) {
    // Across sessions it searches the bots; a chat's find names its own session.
    if (only.length === 0 && session.kind !== "bot") continue;
    if (only.length > 0 && !only.includes(session.id as string)) continue;
    // thread() materializes the seed; a search should not depend on
    // whether someone opened the chat first.
    const blocks = thread(session.id as string).blocks;
    blocks.forEach((block, index) => {
      const text = String(block.text ?? "");
      const at = (block.at as number | undefined) ?? Date.now();
      const found = text.toLowerCase().indexOf(query);
      if (found < 0 || (from !== undefined && at < from)) return;
      // The daemon snippets by token; slicing by character would cut a word in
      // half and make the mock look worse than the thing it stands in for.
      const before = text.slice(0, found);
      const after = text.slice(found + query.length);
      // A long run with no whitespace in it keeps its tail rather than
      // collapsing to a bare ellipsis.
      const lead = before.slice(-40);
      const word = lead.replace(/^\S*\s*/, "");
      const head = before.length > 40 ? `…${word || lead}` : before;
      const tail = after.length > 80 ? `${after.slice(0, 80).replace(/\s*\S*$/, "")}…` : after;
      const window = `${head}${text.slice(found, found + query.length)}${tail}`;
      const start = window.toLowerCase().indexOf(query);
      hits.push({
        sessionId: session.id,
        sessionName: session.name,
        pos: index + 1,
        id: block.id,
        role: block.role,
        at,
        snippet: `${window.slice(0, start)}\ue000${window.slice(start, start + query.length)}\ue001${window.slice(start + query.length)}`,
      });
    });
  }
  hits.sort((a, b) => (b.at as number) - (a.at as number));
  return hits.slice(0, (args.limit as number | undefined) ?? 50);
}

/** A tool row the way Crew's own tools land in a transcript. */
function crewCall(id: string, title: string, detail: Row, status = "completed", at = now - 40 * 60e3): Row {
  return { id, role: "tool", text: title, at, tool: { callId: `call-${id}`, name: `mcp__crew__${title.split(" ")[0]}`, title, status, detail } };
}

/** One of a subagent's own calls, as its row nests it. */
function step(id: string, name: string, title: string, detail: Row, status = "completed"): Row {
  return { id, role: "tool", text: title, tool: { callId: `call-${id}`, name, title, status, detail } };
}

const START = 40 * 60e3;
/** Lead's chat and its children's: every piece of the orchestration UI, once. */
const ORCHESTRATION: Record<string, Row[]> = {
  s7: [
    { id: "o-u1", role: "user", at: now - START - 6e4, text: "Split the auth refactor and the billing tests between two sessions, and keep me posted." },
    { id: "o-r1", role: "reasoning", text: "Two independent jobs: auth in its own worktree, billing tests in place." },
    { id: "o-t1", role: "tool", text: "Read docs/plan.md", tool: { callId: "o-c1", name: "Read", title: "Read docs/plan.md", status: "completed", detail: { kind: "file", path: "/Users/me/Developer/experiments/crew/docs/plan.md" } } },
    {
      id: "o-t2",
      role: "tool",
      text: "Task Map the token flow",
      tool: {
        callId: "o-c2",
        name: "Task",
        title: "Map the token flow",
        status: "completed",
        detail: {
          kind: "agent",
          description: "Map the session token flow",
          agentType: "Explore",
          prompt: "Find every place the session token is read, refreshed or written. List file:line and what each does.",
          output: "- `auth/middleware.ts:41` reads the cookie\n- `auth/middleware.ts:88` refreshes it inline\n- `api/client.ts:12` retries on 401",
          state: "done",
          steps: [
            step("o-s1", "Grep", "Grep session_token", { kind: "search", query: "session_token", matches: 9, output: "auth/middleware.ts\napi/client.ts\nauth/session.ts" }),
            step("o-s2", "Read", "Read auth/middleware.ts", { kind: "file", path: "/Users/me/Developer/experiments/crew/auth/middleware.ts", lineStart: 30, lineEnd: 95 }),
            { id: "o-s3", role: "assistant", text: "The middleware reads and refreshes it; the client only retries. Checking the session module." },
            step("o-s4", "Read", "Read auth/session.ts", { kind: "file", path: "/Users/me/Developer/experiments/crew/auth/session.ts" }),
            step("o-s5", "Read", "Read api/client.ts", { kind: "file", path: "/Users/me/Developer/experiments/crew/api/client.ts", lineStart: 1, lineEnd: 40 }),
          ],
        },
      },
    },
    crewCall("o-t3", "start_session Auth refactor", { kind: "message", to: "Auth refactor", text: AUTH_JOB, letterId: "o1", toId: "c1", toName: "Auth refactor", what: "start", delivery: "started" }),
    { id: "o-s1", role: "system", text: "Started session Auth refactor (c1)", letterId: "o1", at: now - START },
    crewCall("o-t4", "start_session Billing tests", { kind: "message", to: "Billing tests", text: "Write the missing tests", letterId: "o2", toId: "c2", toName: "Billing tests", what: "start", delivery: "started" }),
    { id: "o-s2", role: "system", text: "Started session Billing tests (c2)", letterId: "o2", at: now - START + 2e4 },
    crewCall("o-t5", "send_message Lead", { kind: "message", to: "Lead", text: "Note to self: check billing first.", error: "You cannot send a message to yourself." }, "failed"),
    { id: "o-t7", role: "tool", text: "git worktree list", tool: { callId: "o-c7", name: "Bash", title: "git worktree list", status: "completed", detail: { kind: "command", command: "git worktree list", exitCode: 0 } } },
    {
      id: "o-a1",
      role: "assistant",
      at: now - START + 4.8e4,
      text: "Both are running: **Auth refactor** in `feat/auth-refactor`, **Billing tests** in place. Their reports wake me when they finish.",
      usage: { inputTokens: 21000, outputTokens: 420, costUsd: 0.05, durationMs: 48000 },
    },
    { id: "o-u2", role: "user", at: now - 25 * 60e3, text: BILLING_REPORT, letterId: "o3", fromBot: { id: "c2", name: "Billing tests", kind: "session" } },
    {
      id: "o-a2",
      role: "assistant",
      at: now - 25 * 60e3 + 9e3,
      text: "Billing tests reported: 14 new tests and one real rounding bug in prorated refunds, left failing on purpose. Want a session on the fix?",
      usage: { inputTokens: 9000, outputTokens: 120, costUsd: 0.01, durationMs: 9000 },
    },
    { id: "o-s3", role: "system", text: "You wrote to Auth refactor", letterId: "o4", at: now - 15 * 60e3 },
    { id: "o-u3", role: "user", at: now - 10 * 60e3 - 3e4, text: "Hand the payments migration to a new session in its own worktree; I'll drive it." },
    crewCall("o-t6", "start_session Payments migration", { kind: "message", to: "Payments migration", text: "Carry on the payments migration", letterId: "o5", toId: "h1", toName: "Payments migration", what: "handoff", delivery: "started" }, "completed", now - 10 * 60e3),
    { id: "o-s4", role: "system", text: "Handed Payments migration (h1) to the user", letterId: "o5", at: now - 10 * 60e3 },
    {
      id: "o-a3",
      role: "assistant",
      at: now - 10 * 60e3 + 4e3,
      text: "Handed off: **Payments migration** is yours now, in its own worktree, with the plan as its first message.",
      usage: { inputTokens: 6000, outputTokens: 60, costUsd: 0.006, durationMs: 4000 },
    },
  ],
  "history:h1": [
    { id: "h1-u1", role: "user", at: now - 10 * 60e3, text: "Carry on the payments migration in its own worktree.", letterId: "o5", fromBot: { id: "s7", name: "Lead" } },
    { id: "h1-a1", role: "assistant", at: now - 9 * 60e3, text: "Starting with step 1: `payments.v2` behind the flag." },
  ],
  c1: [
    { id: "c1-u1", role: "user", at: now - START, text: AUTH_JOB, letterId: "o1", fromBot: { id: "s7", name: "Lead" } },
    { id: "c1-t1", role: "tool", text: "Read auth/middleware.ts", tool: { callId: "c1-c1", name: "Read", title: "Read auth/middleware.ts", status: "completed", detail: { kind: "file", path: "/Users/me/Developer/experiments/crew/auth/middleware.ts" } } },
    { id: "c1-u2", role: "user", at: now - 15 * 60e3, text: "Keep the old cookie name for one release so existing sessions survive the deploy.", letterId: "o4" },
    { id: "c1-t3", role: "tool", text: "npm run dev", at: now - 12 * 60e3, tool: { callId: "c1-c3", name: "Bash", title: "npm run dev", status: "completed", detail: { kind: "command", command: "npm run dev" } } },
    { id: "c1-t4", role: "tool", text: "npm test -- --watch auth", tool: { callId: "c1-c4", name: "Bash", title: "npm test -- --watch auth", status: "completed", detail: { kind: "command", command: "npm test -- --watch auth" } } },
    {
      id: "c1-t5",
      role: "tool",
      text: "Find every caller of refreshToken",
      tool: {
        callId: "c1-c5",
        name: "Agent",
        title: "Find every caller of refreshToken",
        status: "completed",
        detail: {
          kind: "agent",
          description: "Find every caller of refreshToken",
          agentType: "Explore",
          prompt: "List every caller of refreshToken with file:line, and say which ones run on the request path.",
          background: true,
          state: "running",
          activity: "Reading api/retry.ts",
          steps: [
            step("c1-s1", "Grep", "Grep refreshToken\\(", { kind: "search", query: "refreshToken\\(", matches: 6 }),
            step("c1-s2", "Read", "Read auth/middleware.ts", { kind: "file", path: "/Users/me/Developer/experiments/crew/auth/middleware.ts", lineStart: 80, lineEnd: 120 }),
            { id: "c1-s3", role: "assistant", text: "Two callers on the request path so far; the retry wrapper is next." },
            step("c1-s4", "Read", "Read api/retry.ts", { kind: "file", path: "/Users/me/Developer/experiments/crew/api/retry.ts" }, "pending"),
          ],
        },
      },
    },
    { id: "c1-t2", role: "tool", text: "Edit auth/session.ts", tool: { callId: "c1-c2", name: "Edit", title: "Edit auth/session.ts", status: "pending", detail: { kind: "edit", path: "auth/session.ts", added: 42, removed: 3 } } },
  ],
};

/**
 * What each session's turn left running in the background. Auth refactor has
 * answered and waits on its dev server and its tests (its tab counts them);
 * a build it ran finished.
 */
const background = new Map<string, Row>([
  [
    "c1",
    {
      sessionId: "c1",
      live: true,
      waiting: true,
      commands: [
        { id: "bg-dev", command: "npm run dev", description: "Start the dev server", kind: "shell", startedAt: now - 12 * 60e3, state: "running", toolCallId: "c1-c3" },
        { id: "bg-test", command: "npm test -- --watch auth", kind: "shell", startedAt: now - 11 * 60e3, state: "running", toolCallId: "c1-c4" },
        { id: "bg-build", command: "pnpm build", kind: "shell", startedAt: now - 9 * 60e3, state: "completed", exitCode: 0, endedAt: now - 8 * 60e3 },
        { id: "bg-agent", command: "Map the token flow", kind: "subagent", startedAt: now - 7 * 60e3, state: "failed", endedAt: now - 6 * 60e3 },
      ],
    },
  ],
]);
const outputs = new Map<string, string>([
  ["bg-dev", "\x1b[32m  VITE v7.1.0\x1b[0m  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n"],
  ["bg-test", " RUN  v3.2.7 /Users/me/Developer/experiments/crew\n\n ✓ auth/session.test.ts (12 tests) 31ms\n ✓ auth/middleware.test.ts (8 tests) 22ms\n\n Test Files  2 passed (2)\n      Tests  20 passed (20)\n\n Waiting for file changes...\n"],
  ["bg-build", "> crew@0.2.7 build\n> tsc --noEmit && vite build\n\n✓ 1843 modules transformed.\n✓ built in 6.21s\n"],
]);

function backgroundList(sessionId: string): Row {
  return background.get(sessionId) ?? { sessionId, commands: [], live: false, waiting: false };
}

function backgroundOutput(sessionId: string, id: string): Row {
  const list = background.get(sessionId);
  const running = ((list?.commands as Row[] | undefined) ?? []).find((row) => row.id === id)?.state === "running";
  // A running one writes a line a second.
  if (running && id === "bg-dev") outputs.set(id, `${outputs.get(id) ?? ""}${new Date().toLocaleTimeString()} [vite] page reload src/App.tsx\n`);
  return { output: outputs.get(id) ?? "", truncated: false };
}

function backgroundStop(sessionId: string, id: string): null {
  const list = background.get(sessionId);
  if (!list) throw new Error("No such background command.");
  const commands = (list.commands as Row[]).map((row) =>
    row.id === id && row.state === "running" ? { ...row, state: "stopped", endedAt: Date.now() } : row,
  );
  const next = { ...list, commands, waiting: commands.some((row) => row.state === "running") };
  background.set(sessionId, next);
  emit("background-changed", next);
  return null;
}

type MockTurn = { sessionId: string; stage: "idle" | "question" | "approval" };
type TranscriptRow = { blocks: Row[]; seq: number; working: boolean; status: string };
const turns = new Map<string, MockTurn>();
const transcripts = new Map<string, TranscriptRow>();

/**
 * `?history=400` seeds that many older lines in front of the seed, so the
 * window's "earlier messages" path and a long transcript can be looked at
 * without waiting for one to happen.
 */
function backfill(): Row[] {
  const asked = Number(new URLSearchParams(location.search).get("history") ?? 0);
  const count = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), 5000) : 0;
  return Array.from({ length: count }, (_, index) => ({
    id: `old${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    at: now - (count - index) * 60e3 - 48 * 3600e3,
    text:
      index % 2 === 0
        ? `Older question ${index + 1}: where did the sidebar grouping end up?`
        : `Older answer ${index + 1}. It lives in groupSessions, memoised per render input.`,
  }));
}

function thread(id: string): TranscriptRow {
  let row = transcripts.get(id);
  if (!row) {
    row = {
      blocks:
        id === "s1"
          ? [...backfill(), ...(SEED_BLOCKS as Row[]).map((block) => ({ ...block }))]
          : (ORCHESTRATION[id] ?? []).map((block) => ({ ...block })),
      seq: 0,
      working: id === "s1" || id === "c1",
      status: id === "s1" ? "needs-input" : "idle",
    };
    transcripts.set(id, row);
  }
  return row;
}

function emitApply(sessionId: string, event: Row) {
  const row = thread(sessionId);
  row.seq += 1;
  emit("transcript-apply", { sessionId, seq: row.seq, event });
}

function emitStatus(sessionId: string, status: string) {
  const row = thread(sessionId);
  row.status = status;
  row.working = status === "working" || status === "needs-input";
  const session = sessions.find((item) => item.id === sessionId);
  if (session) session.status = status;
  emit("session-status", { sessionId, status, updatedAt: Date.now() });
}

/** Words at 40ms, then `then` after the last one. */
function say(sessionId: string, text: string, at: number, then?: () => void): number {
  const words = text.split(" ");
  words.forEach((word, i) =>
    setTimeout(() => emitApply(sessionId, { type: "message.delta", text: (i ? " " : "") + word }), at + i * 40),
  );
  const end = at + words.length * 40 + 120;
  if (then) setTimeout(then, end);
  return end;
}

const EDIT_INPUT = {
  file_path: "/Users/me/Developer/experiments/crew/src/lib/sidebarPrefs.ts",
  old_string: "  return prefs.hidden.includes(key);",
  new_string: "  return hiddenSet(prefs).has(key);",
};

const REPLY = [
  "Lint is clean. `shows` now reads from a `Set` built once per prefs object:",
  "",
  "```ts",
  "const hiddenSet = (prefs: SidebarPrefs) => new Set(prefs.hidden);",
  "",
  "export function shows(prefs: SidebarPrefs, key: string): boolean {",
  "  return !hiddenSet(prefs).has(key);",
  "}",
  "```",
  "",
  "Run `npm run check` when you want the full pass.",
].join("\n");

const QUESTIONS = [
  {
    question: "Where should the Set live?",
    header: "Cache",
    multiSelect: false,
    options: [
      { label: "Per call", description: "Build it inside shows(); simplest, still O(n) once per row" },
      { label: "Memoized on prefs", description: "WeakMap keyed by the prefs object" },
    ],
  },
  {
    question: "What else should I touch?",
    header: "Scope",
    multiSelect: true,
    options: [
      { label: "Run the linter" },
      { label: "Add a test" },
      { label: "Update ARCHITECTURE.md" },
    ],
  },
];

/**
 * One scripted turn: prose, a read, a two-step question, an edit that needs
 * approval, a reply with code. Everything the chat has to paint, in order.
 */
function playTurn(sessionId: string) {
  turns.set(sessionId, { sessionId, stage: "idle" });
  say(sessionId, "Let me look at how the lookup is built.", 300, () => {
    emitApply(sessionId, {
      type: "tool.started",
      callId: "t1",
      name: "Read",
      title: "Read src/lib/sidebarPrefs.ts",
    });
    setTimeout(
      () =>
        emitApply(sessionId, {
          type: "tool.updated",
          callId: "t1",
          status: "completed",
        }),
      600,
    );
    setTimeout(() => {
      const turn = turns.get(sessionId);
      if (turn) turn.stage = "question";
      emitStatus(sessionId, "needs-input");
      emitApply(sessionId, { type: "question.requested", requestId: 1, questions: QUESTIONS });
    }, 800);
  });
}

function mockAnswer(sessionId: string, requestId: number, answers: Row | null) {
  const turn = turns.get(sessionId);
  if (!turn || turn.stage !== "question") return;
  turn.stage = "idle";
  emitApply(sessionId, { type: "question.resolved", requestId, answers });
  emitStatus(sessionId, "working");
  const summary = answers
    ? `Going with ${Object.values(answers).join(" and ")}.`
    : "No answer, so I will keep the current behaviour.";
  say(sessionId, summary, 300, () => {
    turn.stage = "approval";
    emitStatus(sessionId, "needs-input");
    emitApply(sessionId, {
      type: "approval.requested",
      requestId: 2,
      name: "Edit",
      title: "Edit sidebarPrefs.ts",
      input: EDIT_INPUT,
    });
  });
}

function mockRespond(sessionId: string, requestId: number, decision: string) {
  const turn = turns.get(sessionId);
  if (!turn || turn.stage !== "approval") return;
  turn.stage = "idle";
  emitApply(sessionId, { type: "approval.resolved", requestId, decision });
  emitStatus(sessionId, "working");
  const allowed = decision === "allow" || decision === "always";
  setTimeout(() => {
    emitApply(sessionId, {
      type: "tool.started",
      callId: "t2",
      name: "Edit",
      title: "Edit sidebarPrefs.ts",
    });
  }, 100);
  setTimeout(() => {
    emitApply(sessionId, {
      type: "tool.updated",
      callId: "t2",
      status: allowed ? "completed" : "failed",
    });
  }, 700);
  const tail = allowed ? REPLY : "Skipped the edit. Say the word and I will apply it.";
  const end = say(sessionId, tail, 900);
  setTimeout(() => {
    emitApply(sessionId, {
      type: "turn.completed",
      usage: { inputTokens: 8200, outputTokens: 140, costUsd: 0.012, durationMs: 4100 },
    });
    emitStatus(sessionId, "done");
  }, end);
}

async function request<T>(method: string, params: object = {}, envId?: string): Promise<T> {
  const handler = commands[method];
  if (!handler) throw new Error(`mock: unknown method ${method}`);
  envNow = envId ?? "local";
  try {
    return handler(params as Row) as T;
  } finally {
    envNow = "local";
  }
}

function on(event: string, listener: Listener): () => void {
  const set = listeners.get(event) ?? new Set();
  set.add(listener);
  listeners.set(event, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
  };
}

/**
 * `replay` false drops what arrived before: a viewer about to attach gets
 * its bytes from the daemon's ring, from a known offset, and a buffer that
 * starts wherever the frames happened to start would paint ahead of it.
 */
function openStream(id: number, onBytes: (bytes: Uint8Array) => void, replay = true): () => void {
  closed.delete(id);
  streams.set(id, onBytes);
  const queue = buffered.get(id);
  if (queue) {
    buffered.delete(id);
    bufferedBytes.delete(id);
    if (replay) for (const chunk of queue) onBytes(chunk);
  }
  return () => {
    if (streams.get(id) === onBytes) streams.delete(id);
    buffered.delete(id);
    bufferedBytes.delete(id);
    closed.add(id);
  };
}

function onReconnect(_hook: () => void): () => void {
  return () => {};
}

function writeStream(_id: number, _bytes: Uint8Array): Promise<void> {
  return Promise.resolve();
}

/** A prompt a beat after spawn, so the status machinery has something to chew on. */
function mockShell(_id: string, streamId: number) {
  const encoder = new TextEncoder();
  const say = (text: string) => pushBytes(streamId, encoder.encode(text));
  setTimeout(() => say("Last login: today on ttys000\r\n"), 50);
  setTimeout(() => say("\x1b[32m❯\x1b[0m "), 250);
}

export const transport = { request, on, onReconnect, openStream, writeStream };
