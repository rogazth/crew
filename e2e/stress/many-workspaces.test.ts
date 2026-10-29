// Stress: a heavy user's window. Eight workspaces shaped like a real data set
// (one with hundreds of sessions, the rest tapering off), bots, subagents,
// transcripts written straight to the database, and a strip of open tabs in
// each. Every interaction is timed from the input event to the first frame
// that shows its result, and React's commits are counted through a stand-in
// for the DevTools hook: how many components rendered, and which.
//
//   npm run e2e -- --stress many-workspaces
//   STRESS_SCALE=2 npm run e2e -- --stress many-workspaces
//   STRESS_OUT=/some/file.json …   → the numbers, as JSON
//   CREW_KEEP_NAMES=1 …            → the census names components (the build keeps their names)
//
// Diagnostics only: nothing here fails on a number.
import { writeFile } from "node:fs/promises";
import { after, before, test, type TestContext } from "node:test";
import { composerOf, MOD, pressChord, waitFor, workspaceMark, type Crew } from "../harness.ts";
import { seedHeavy, type Seeded } from "./heavy.ts";

const SCALE = Number(process.env.STRESS_SCALE ?? 1);

let crew: Crew;
let seeded: Seeded[] = [];

// ---------- the probe ----------

/**
 * Runs before the app's own scripts: a DevTools hook React reports every
 * commit to, a long-task observer, event timing, and the input's own time.
 */
function probe() {
  type Fiber = { tag: number; flags: number; type: unknown; memoizedProps: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
  const COMPONENTS = new Set([0, 1, 11, 14, 15]);
  const PERFORMED_WORK = 1;
  const perf = {
    // A reload asks for the census from the start, so the first mount is counted too.
    count: sessionStorage.getItem("__perfCount") === "1",
    commits: [] as number[],
    rendered: 0,
    mounted: 0,
    byName: new Map<string, number>(),
    /** Components that rendered with the props they had: a state, store or context change started there. */
    origins: new Map<string, number>(),
    longTasks: [] as { t: number; d: number }[],
    events: [] as { name: string; t: number; d: number }[],
    lastInput: 0,
    seenAt: 0,
    reset() {
      perf.commits = [];
      perf.rendered = 0;
      perf.mounted = 0;
      perf.byName = new Map();
      perf.origins = new Map();
      perf.longTasks = [];
      perf.events = [];
      perf.seenAt = 0;
    },
  };
  (window as unknown as { __perf: typeof perf }).__perf = perf;
  const nameOf = (fiber: Fiber) => {
    let type = fiber.type as { $$typeof?: symbol; type?: unknown; render?: unknown; displayName?: string; name?: string } | null;
    if (!type) return "?";
    if (type.type) type = type.type as typeof type;
    if (type.render) type = type.render as typeof type;
    return type.displayName || type.name || "anonymous";
  };
  const walk = (root: { current: Fiber }) => {
    const stack: [Fiber, Fiber | null][] = [[root.current, root.current.alternate]];
    while (stack.length) {
      const [next, prev] = stack.pop()!;
      if (COMPONENTS.has(next.tag)) {
        const kind = !prev ? "mount" : next.flags & PERFORMED_WORK ? "render" : null;
        if (kind) {
          if (kind === "mount") perf.mounted++;
          else perf.rendered++;
          const name = nameOf(next);
          perf.byName.set(name, (perf.byName.get(name) ?? 0) + 1);
          if (prev && next.memoizedProps === prev.memoizedProps) perf.origins.set(name, (perf.origins.get(name) ?? 0) + 1);
        }
      }
      const child = next.child;
      // A subtree that did no work keeps its old child: nothing under it rendered.
      if (!child || (prev && child === prev.child)) continue;
      for (let c: Fiber | null = child; c; c = c.sibling) stack.push([c, prev ? c.alternate : null]);
    }
  };
  let renderers = 0;
  (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject() {
      return ++renderers;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      perf.commits.push(performance.now());
      if (perf.count) walk(root);
    },
  };
  const mark = (event: Event) => {
    perf.lastInput = event.timeStamp;
  };
  addEventListener("keydown", mark, true);
  addEventListener("pointerdown", mark, true);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.longTasks.push({ t: entry.startTime, d: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.events.push({ name: entry.name, t: entry.startTime, d: entry.duration });
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
}

type Probe = {
  /** Input → first frame showing the result. */
  latency: number;
  /** Input → last commit before things went quiet. */
  settled: number;
  /** The slowest event-timing entry since the input: Chromium's own input-to-paint. */
  event: number;
  commits: number;
  longTaskMs: number;
  rendered: number;
  mounted: number;
  top: [string, number][];
  origins: [string, number][];
};

/** Watches, frame by frame, for the visible code element reading `marker`. Armed before the input. */
async function arm(crew: Crew, marker: string, count: boolean) {
  await crew.window.evaluate(
    ([marker, count]) => {
      const perf = (window as unknown as { __perf: { count: boolean; seenAt: number; reset(): void } }).__perf;
      perf.reset();
      perf.count = count;
      let known: Element | null = null;
      const tick = () => {
        if (!known || !known.isConnected) {
          known = null;
          for (const el of document.getElementsByTagName("code")) if (el.textContent === marker) known = el;
        }
        if (known && known.checkVisibility()) {
          perf.seenAt = performance.now();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [marker, count] as const,
  );
}

/** Once the marker showed and nothing committed for `quiet` ms, what it cost. */
async function collect(crew: Crew, what: string, quiet = 500): Promise<Probe> {
  await waitFor(() => crew.window.evaluate(() => (window as unknown as { __perf: { seenAt: number } }).__perf.seenAt > 0), {
    message: `${what} on screen`,
    timeout: 60_000,
    interval: 20,
  });
  return waitFor(
    () =>
      crew.window.evaluate((quiet) => {
        const perf = (window as unknown as { __perf: Record<string, unknown> }).__perf as {
          commits: number[];
          longTasks: { t: number; d: number }[];
          events: { name: string; t: number; d: number }[];
          lastInput: number;
          seenAt: number;
          rendered: number;
          mounted: number;
          byName: Map<string, number>;
          origins: Map<string, number>;
          count: boolean;
        };
        const now = performance.now();
        const lastCommit = perf.commits.at(-1) ?? perf.seenAt;
        const lastTask = perf.longTasks.reduce((end, task) => Math.max(end, task.t + task.d), 0);
        if (now - Math.max(lastCommit, lastTask, perf.seenAt) < quiet) return null;
        const since = perf.lastInput;
        perf.count = false;
        return {
          latency: Math.round(perf.seenAt - since),
          settled: Math.round(Math.max(lastCommit, perf.seenAt) - since),
          event: Math.round(perf.events.filter((e) => e.t >= since - 1).reduce((max, e) => Math.max(max, e.d), 0)),
          commits: perf.commits.filter((t) => t >= since).length,
          longTaskMs: Math.round(perf.longTasks.filter((l) => l.t >= since - 1).reduce((sum, l) => sum + l.d, 0)),
          rendered: perf.rendered,
          mounted: perf.mounted,
          top: [...perf.byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
          origins: [...perf.origins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
        };
      }, quiet),
    { message: `${what} settles`, timeout: 60_000, interval: 50 },
  );
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) };
}

function summary(probes: Probe[]) {
  return {
    latency: stats(probes.map((p) => p.latency)),
    settled: stats(probes.map((p) => p.settled)),
    event: stats(probes.map((p) => p.event)),
    longTaskMs: stats(probes.map((p) => p.longTaskMs)),
    commits: stats(probes.map((p) => p.commits)),
  };
}

function census(probes: Probe[]) {
  const names = new Map<string, number>();
  for (const p of probes) for (const [name, n] of p.top) names.set(name, (names.get(name) ?? 0) + n);
  const origins = new Map<string, number>();
  for (const p of probes) for (const [name, n] of p.origins) origins.set(name, (origins.get(name) ?? 0) + n);
  const per = (map: Map<string, number>, n: number) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => `${name}×${Math.round(count / probes.length)}`);
  return {
    renderedPer: stats(probes.map((p) => p.rendered)),
    mountedPer: stats(probes.map((p) => p.mounted)),
    top: per(names, 15),
    origins: per(origins, 15),
  };
}

const results: Record<string, unknown> = {};

before(async () => {
  ({ crew, seeded } = await seedHeavy({ scale: SCALE }));
  await crew.app.context().addInitScript(probe);
});

after(async () => {
  if (process.env.STRESS_OUT) await writeFile(process.env.STRESS_OUT, JSON.stringify(results, null, 2));
  await crew?.close();
});

/** ⌘<n>: the n-th project. Arms on its first tab's marker. */
async function goTo(n: number, count: boolean): Promise<Probe> {
  const target = seeded[n]!;
  await arm(crew, target.marker(target.tabs[0]!), count);
  await pressChord(crew, `${MOD}+${n + 1}`);
  return collect(crew, `workspace ${target.workspace.name}`);
}

/** Back to the first workspace, untimed, and waits for it to settle. */
async function home(): Promise<void> {
  const first = seeded[0]!;
  await arm(crew, first.marker(first.tabs[0]!), false);
  await pressChord(crew, `${MOD}+1`);
  await collect(crew, "the first workspace");
}

test("a heavy user's window, timed", { timeout: 30 * 60_000 }, async (t: TestContext) => {
  const total = seeded.reduce((sum, s) => sum + s.sessions.length, 0);
  t.diagnostic(`seeded: ${seeded.length} workspaces, ${total} sessions, ${seeded.reduce((s, x) => s + x.tabs.length, 0)} tabs`);
  results.seeded = { workspaces: seeded.length, sessions: total, scale: SCALE };

  // Cold start: a reload, timed from navigation to the first workspace's chat on screen.
  const cold: { firstCommit: number; rail: number; chat: number; settled: number; longTaskMs: number; commits: number; mounted: number }[] = [];
  const first = seeded[0]!;
  for (let i = 0; i < 5; i++) {
    await crew.window.evaluate((marker) => {
      sessionStorage.setItem("__perfMarker", marker);
      sessionStorage.setItem("__perfCount", "1");
    }, first.marker(first.tabs[0]!));
    await crew.window.reload();
    const at = await waitFor(
      () =>
        crew.window.evaluate(() => {
          const marker = sessionStorage.getItem("__perfMarker");
          for (const el of document.getElementsByTagName("code")) {
            if (el.textContent === marker && el.checkVisibility()) return performance.now();
          }
          return 0;
        }),
      { message: "cold chat on screen", timeout: 60_000, interval: 10 },
    );
    await workspaceMark(crew, first.workspace.name).waitFor();
    const quiet = await waitFor(
      () =>
        crew.window.evaluate(() => {
          const perf = (window as unknown as { __perf: { commits: number[]; longTasks: { t: number; d: number }[]; mounted: number } }).__perf;
          const now = performance.now();
          const last = Math.max(perf.commits.at(-1) ?? 0, perf.longTasks.reduce((e, l) => Math.max(e, l.t + l.d), 0));
          if (now - last < 800) return null;
          sessionStorage.removeItem("__perfCount");
          (perf as unknown as { count: boolean }).count = false;
          const rail = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint")?.startTime ?? 0;
          return {
            firstCommit: Math.round(perf.commits[0] ?? 0),
            rail: Math.round(rail),
            settled: Math.round(last),
            longTaskMs: Math.round(perf.longTasks.reduce((s, l) => s + l.d, 0)),
            commits: perf.commits.length,
            mounted: perf.mounted,
          };
        }),
      { message: "cold settles", timeout: 60_000, interval: 100 },
    );
    cold.push({ ...quiet, chat: Math.round(at) });
  }
  results.cold = cold;
  t.diagnostic(`cold start (ms from navigation): ${JSON.stringify(cold)}`);

  // First visits: every other workspace, once, mounting its tabs.
  const firsts: Probe[] = [];
  for (let n = 1; n < seeded.length; n++) firsts.push(await goTo(n, true));
  results.firstVisit = { ...summary(firsts), ...census(firsts), each: firsts.map((p) => [p.latency, p.settled, p.mounted]) };
  t.diagnostic(`workspace first visit: ${JSON.stringify(results.firstVisit)}`);
  await home();

  // Revisits, timed with the census off, then once more counting renders.
  const warm: Probe[] = [];
  for (let round = 0; round < 3; round++) for (let n = 0; n < seeded.length; n++) warm.push(await goTo((n + 1) % seeded.length, false));
  results.revisit = summary(warm);
  t.diagnostic(`workspace revisit: ${JSON.stringify(results.revisit)}`);
  const warmCensus: Probe[] = [];
  for (let n = 0; n < seeded.length; n++) warmCensus.push(await goTo((n + 1) % seeded.length, true));
  results.revisitCensus = census(warmCensus);
  t.diagnostic(`workspace revisit renders: ${JSON.stringify(results.revisitCensus)}`);
  await home();

  // Tabs of the biggest workspace, stepped through with ⌘⇧[.
  const tabs = first.tabs;
  const order = [0, ...tabs.map((_, i) => (tabs.length - 1 - i) % tabs.length)].slice(1);
  // The first round shows each tab for the first time since the reload; the next ones come back to it.
  const rounds: Probe[][] = [[], [], []];
  for (const [round, probes] of rounds.entries()) {
    for (const index of order) {
      await arm(crew, first.marker(tabs[index]!), round !== 1);
      await pressChord(crew, `${MOD}+Shift+BracketLeft`);
      probes.push(await collect(crew, `tab ${index}`));
    }
  }
  const [firstShow, warmSteps, stepCensus] = rounds as [Probe[], Probe[], Probe[]];
  results.tabFirstShow = { ...summary(firstShow), ...census(firstShow) };
  t.diagnostic(`tab first show in ${first.workspace.name}: ${JSON.stringify(results.tabFirstShow)}`);
  results.tabSwitch = { ...summary(warmSteps), ...census(stepCensus) };
  t.diagnostic(`tab switch in ${first.workspace.name}: ${JSON.stringify(results.tabSwitch)}`);

  // A session somewhere else changes (what a turn's end or a rename sends): what the window redraws.
  const elsewhere = seeded.slice(1).flatMap((s) => s.sessions.filter((x) => !s.tabs.includes(x)).slice(0, 4));
  const updates: { ms: number; rendered: number; commits: number; top: [string, number][]; origins: [string, number][] }[] = [];
  for (const [i, session] of elsewhere.entries()) {
    await crew.window.evaluate(() => {
      const perf = (window as unknown as { __perf: { reset(): void; count: boolean } }).__perf;
      perf.reset();
      perf.count = true;
    });
    await crew.request("session_update", {
      id: session.id,
      name: session.name,
      provider: "claude",
      model: "",
      description: `Pass ${i}`,
      notifications: true,
      autonomy: "ask",
    });
    updates.push(
      await waitFor(
        () =>
          crew.window.evaluate(() => {
            const perf = (window as unknown as { __perf: { commits: number[]; longTasks: { t: number; d: number }[]; rendered: number; byName: Map<string, number>; origins: Map<string, number>; count: boolean } }).__perf;
            const last = perf.commits.at(-1);
            if (last === undefined || performance.now() - last < 300) return null;
            perf.count = false;
            return {
              ms: Math.round(perf.longTasks.reduce((s, l) => s + l.d, 0)),
              rendered: perf.rendered,
              commits: perf.commits.length,
              top: [...perf.byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
              origins: [...perf.origins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
            };
          }),
        { message: "the update lands", timeout: 10_000, interval: 50 },
      ),
    );
  }
  results.backgroundUpdate = {
    rendered: stats(updates.map((u) => u.rendered)),
    commits: stats(updates.map((u) => u.commits)),
    longTaskMs: stats(updates.map((u) => u.ms)),
    top: updates[0]?.top,
    origins: updates[0]?.origins,
  };
  t.diagnostic(`a session elsewhere updates: ${JSON.stringify(results.backgroundUpdate)}`);

  // Typing in the chat on screen.
  await home();
  await composerOf(crew).focus();
  const typing: number[] = [];
  for (const ch of "the quick brown fox jumps over the lazy dog") {
    const t0 = await crew.window.evaluate(() => performance.now());
    await crew.window.keyboard.type(ch);
    typing.push(
      await crew.window.evaluate(
        (t0) => new Promise<number>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0)))),
        t0,
      ),
    );
  }
  results.typing = stats(typing);
  t.diagnostic(`typing: ${JSON.stringify(results.typing)}`);

  // What the window holds once it has shown everything.
  const cdp = await crew.window.context().newCDPSession(crew.window);
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  results.memory = {
    heapMB: Math.round(usedSize / 1e6),
    domNodes: await crew.window.evaluate(() => document.getElementsByTagName("*").length),
  };
  t.diagnostic(`memory: ${JSON.stringify(results.memory)}`);
});
