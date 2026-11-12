// Stress: the sessions sidebar of a workspace with hundreds of sessions, under
// each grouping, folded at 10 and unfolded. Times what grows with the row count:
// one session changing (a rename), and unfolding "N more" into every row.
//
//   npm run e2e -- --stress sidebar
//   STRESS_SCALE=2 npm run e2e -- --stress sidebar
//   CREW_KEEP_NAMES=1 …   → the census names components
//
// Diagnostics only: nothing here fails on a number.
import { after, before, test, type TestContext } from "node:test";
import { waitFor, type Crew } from "../harness.ts";
import { seedHeavy, type Seeded } from "./heavy.ts";

type Grouping = "none" | "worktree" | "status";
type Limit = 5 | 10 | 20 | 0;
/** The view menu's picks this spec does not vary, as `DEFAULT_PREFS` has them (node cannot load that module). */
const BASE = { scope: "all", ordering: "updated", show: ["names", "diff", "updated", "status"], hiddenKinds: [], hiddenProviders: [], recency: "any", showWorktree: true, hiddenTrees: [] };

const SCALE = Number(process.env.STRESS_SCALE ?? 1);
const ROUNDS = 8;

let crew: Crew;
let biggest: Seeded;

/** Commits, components rendered and long tasks, from a stand-in for the DevTools hook. */
function probe() {
  type Fiber = { tag: number; flags: number; type: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
  const COMPONENTS = new Set([0, 1, 11, 14, 15]);
  const perf = {
    t0: 0,
    seenAt: 0,
    commits: [] as number[],
    rendered: 0,
    byName: new Map<string, number>(),
    longTasks: [] as { t: number; d: number }[],
    reset() {
      perf.t0 = performance.now();
      perf.seenAt = 0;
      perf.commits = [];
      perf.rendered = 0;
      perf.byName = new Map();
      perf.longTasks = [];
    },
  };
  (window as unknown as { __perf: typeof perf }).__perf = perf;
  const nameOf = (fiber: Fiber) => {
    let type = fiber.type as { type?: unknown; render?: unknown; displayName?: string; name?: string } | null;
    if (!type) return "?";
    if (type.type) type = type.type as typeof type;
    if (type.render) type = type.render as typeof type;
    return type.displayName || type.name || "anonymous";
  };
  const walk = (root: { current: Fiber }) => {
    const stack: [Fiber, Fiber | null][] = [[root.current, root.current.alternate]];
    while (stack.length) {
      const [next, prev] = stack.pop()!;
      if (COMPONENTS.has(next.tag) && (!prev || next.flags & 1)) {
        perf.rendered++;
        const name = nameOf(next);
        perf.byName.set(name, (perf.byName.get(name) ?? 0) + 1);
      }
      const child = next.child;
      if (!child || (prev && child === prev.child)) continue;
      for (let c: Fiber | null = child; c; c = c.sibling) stack.push([c, prev ? c.alternate : null]);
    }
  };
  let renderers = 0;
  (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => ++renderers,
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      perf.commits.push(performance.now());
      if (perf.t0 > 0) walk(root);
    },
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.longTasks.push({ t: entry.startTime, d: entry.duration });
  }).observe({ type: "longtask", buffered: true });
}

type Probe = { latency: number; settled: number; longTaskMs: number; commits: number; rendered: number; top: [string, number][] };

/** Starts the clock and watches, frame by frame, until `seen` holds in the sidebar. */
async function arm(seen: { name?: string; rowsAbove?: number }) {
  await crew.window.evaluate((seen) => {
    const perf = (window as unknown as { __perf: { reset(): void; seenAt: number } }).__perf;
    perf.reset();
    const sidebar = () => document.querySelector('[data-sidebar="sidebar"]');
    const tick = () => {
      const root = sidebar();
      const ok =
        root &&
        (seen.name !== undefined
          ? [...root.querySelectorAll("[data-session]")].some((el) => el.textContent?.includes(seen.name!))
          : root.querySelectorAll("[data-session]").length > seen.rowsAbove!);
      if (ok) perf.seenAt = performance.now();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, seen);
}

async function collect(what: string, quiet = 400): Promise<Probe> {
  return waitFor(
    () =>
      crew.window.evaluate((quiet) => {
        const perf = (window as unknown as { __perf: Record<string, unknown> }).__perf as {
          t0: number;
          seenAt: number;
          commits: number[];
          rendered: number;
          byName: Map<string, number>;
          longTasks: { t: number; d: number }[];
        };
        if (!perf.seenAt) return null;
        const now = performance.now();
        const lastCommit = perf.commits.at(-1) ?? perf.seenAt;
        if (now - Math.max(lastCommit, perf.seenAt) < quiet) return null;
        const t0 = perf.t0;
        perf.t0 = 0;
        return {
          latency: Math.round(perf.seenAt - t0),
          settled: Math.round(Math.max(lastCommit, perf.seenAt) - t0),
          longTaskMs: Math.round(perf.longTasks.filter((l) => l.t >= t0 - 1).reduce((sum, l) => sum + l.d, 0)),
          commits: perf.commits.filter((t) => t >= t0).length,
          rendered: perf.rendered,
          top: [...perf.byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
        };
      }, quiet),
    { message: `${what} settles`, timeout: 60_000, interval: 50 },
  );
}

const rows = () => crew.window.evaluate(() => document.querySelectorAll('[data-sidebar="sidebar"] [data-session]').length);

function p50(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function summary(probes: Probe[]) {
  return {
    latency: p50(probes.map((p) => p.latency)),
    settled: p50(probes.map((p) => p.settled)),
    longTaskMs: p50(probes.map((p) => p.longTaskMs)),
    rendered: p50(probes.map((p) => p.rendered)),
    top: probes.at(-1)?.top.map(([name, n]) => `${name}×${n}`),
  };
}

before(async () => {
  const { crew: launched, seeded } = await seedHeavy({ scale: SCALE });
  crew = launched;
  biggest = seeded[0]!;
  await crew.app.context().addInitScript(probe);
});

after(async () => {
  await crew?.close();
});

const CONFIGS: { groupBy: Grouping; limit: Limit }[] = [
  { groupBy: "status", limit: 10 },
  { groupBy: "status", limit: 0 },
  { groupBy: "worktree", limit: 10 },
  { groupBy: "worktree", limit: 0 },
  { groupBy: "none", limit: 0 },
];

test("the sessions sidebar, timed", { timeout: 30 * 60_000 }, async (t: TestContext) => {
  t.diagnostic(`seeded: ${biggest.sessions.length} sessions in ${biggest.workspace.name}`);
  // The newest session that finished unread: never folded, so listed under every grouping and limit.
  const target = biggest.sessions.find((s) => s.name.endsWith(" task 8"))!;
  let n = 0;

  for (const config of CONFIGS) {
    const label = `${config.groupBy}/${config.limit === 0 ? "all" : config.limit}`;
    await crew.request("state_set", { key: "sidebar:prefs", value: JSON.stringify({ ...BASE, ...config }) });
    await crew.reload();
    await waitFor(() => rows().then((count) => count > 0 || null), { message: "sidebar rows", timeout: 60_000 });
    await crew.window.waitForTimeout(1500);
    const listed = await rows();

    // One session changes, as every window hears it: every row that re-renders for it is the cost a busy workspace pays per event.
    const renames: Probe[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const name = `renamed ${++n}`;
      await arm({ name });
      await crew.request("session_update", {
        id: target.id,
        name,
        provider: target.provider,
        model: target.model,
        description: target.description ?? "",
        notifications: true,
        autonomy: target.autonomy ?? "ask",
      });
      renames.push(await collect(`${label} rename`));
    }

    // Unfolding the biggest fold mounts every row it held.
    let unfold: Probe | null = null;
    const more = crew.window.locator('[data-sidebar="sidebar"] button', { hasText: /^\d+ more$/ }).first();
    if (await more.count()) {
      await arm({ rowsAbove: listed });
      await more.click();
      unfold = await collect(`${label} unfold`);
    }
    const result = { rows: listed, unfoldedRows: unfold ? await rows() : listed, rename: summary(renames), unfold: unfold && summary([unfold]) };
    t.diagnostic(`${label}: ${JSON.stringify(result)}`);
  }
});
