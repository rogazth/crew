// Stress: 100 sessions opened with ⌘N, one after another, in one window. Each
// press is timed from the key to the first frame that shows the new chat's
// composer, and every frame in between is recorded: a frame with no composer
// on screen is the flicker. Typing in the 100th chat is timed per key.
//
//   npm run e2e -- --stress many-tabs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, sessions, waitFor, type Crew } from "../harness.ts";

const COUNT = Number(process.env.STRESS_TABS ?? 100);

let crew: Crew;

before(async () => {
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
});

type Frame = { t: number; shown: string };
type Press = { n: number; latency: number; frames: Frame[]; longTasks: number[]; worstFrame: number };

/** Frames, as the page paints them: which composer is on screen in each. */
async function record(crew: Crew) {
  await crew.window.evaluate((watchAnimations) => {
    const w = window as unknown as Record<string, unknown>;
    const ids = new WeakMap<Element, number>();
    let next = 1;
    const frames: { t: number; shown: string }[] = [];
    const longTasks: { t: number; d: number }[] = [];
    w.__frames = frames;
    w.__longTasks = longTasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push({ t: entry.startTime, d: entry.duration });
    }).observe({ type: "longtask", buffered: false });
    const tick = (t: number) => {
      let shown = "none";
      let detail = "none";
      for (const area of document.querySelectorAll("textarea:not(.xterm-helper-textarea)")) {
        if ((area as HTMLElement).offsetParent === null) continue;
        if (!ids.has(area)) ids.set(area, next++);
        shown = String(ids.get(area));
        if (watchAnimations) {
          const r = area.getBoundingClientRect();
          const pane = area.closest(".absolute.inset-0");
          const tabs = document.querySelectorAll("[data-tab-id]").length;
          detail = `${shown}@${Math.round(r.top)},${Math.round(r.left)},${Math.round(r.width)}x${Math.round(r.height)} text=${pane?.textContent?.length ?? -1} tabs=${tabs}`;
        } else detail = shown;
        break;
      }
      const anims = !watchAnimations ? [] : document
        .getAnimations()
        .filter((a) => a.playState === "running" && (a.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
        .map((a) => {
          const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
          const name = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? "?";
          return `${name}:${el?.tagName.toLowerCase()}.${String(el?.getAttribute("class") ?? "").split(" ")[0]}${el?.parentElement?.className ? "<" + String(el.parentElement.getAttribute("class")).split(" ")[0] : ""}`;
        });
      if (anims.length) detail += ` anims=[${[...new Set(anims)].join(",")}]`;
      frames.push({ t, shown, detail } as { t: number; shown: string });
      if (frames.length > 4000) frames.splice(0, 2000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, process.env.STRESS_ANIMATIONS === "1");
}

async function press(crew: Crew, workspaceId: string, n: number): Promise<Press> {
  const known = new Set((await sessions(crew, workspaceId)).map((s) => s.id));
  const [t0, before] = await crew.window.evaluate(() => {
    const w = window as unknown as { __frames: { shown: string }[] };
    return [performance.now(), w.__frames.at(-1)?.shown ?? "none"] as const;
  });
  await pressChord(crew, `${MOD}+n`);
  await waitFor(async () => (await sessions(crew, workspaceId)).find((s) => !known.has(s.id)), {
    message: `session ${n} reaches crewd`,
  });
  // Settled: the composer on screen is a new one and has held for a few frames.
  const result = await waitFor(
    () =>
      crew.window.evaluate(
        ([t0, before]) => {
          const w = window as unknown as { __frames: { t: number; shown: string }[]; __longTasks: { t: number; d: number }[] };
          const frames = w.__frames.filter((f) => f.t >= t0);
          const last = frames.at(-1);
          if (!last || last.shown === before || last.shown === "none") return null;
          const firstNew = frames.find((f) => f.shown === last.shown)!;
          if (frames.filter((f) => f.t >= firstNew.t).length < 20) return null;
          const span = frames.filter((f) => f.t <= firstNew.t + 300);
          let worst = 0;
          for (let i = 1; i < frames.length; i++) worst = Math.max(worst, frames[i]!.t - frames[i - 1]!.t);
          return {
            latency: firstNew.t - t0,
            frames: span,
            longTasks: w.__longTasks.filter((l) => l.t >= t0).map((l) => Math.round(l.d)),
            worstFrame: worst,
          };
        },
        [t0, before] as const,
      ),
    { message: `chat ${n} on screen`, timeout: 20_000, interval: 30 },
  );
  return { n, ...result };
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1)!) };
}

test(`${COUNT} sessions opened with ⌘N, timed`, { timeout: 15 * 60_000 }, async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await record(crew);
  if (process.env.STRESS_DROP_RULES) {
    const dropped = await crew.window.evaluate((pattern) => {
      const re = new RegExp(pattern);
      let n = 0;
      const walk = (list: CSSRuleList, remove: (i: number) => void) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const rule = list[i]!;
          if (rule instanceof CSSStyleRule && re.test(rule.selectorText)) { remove(i); n++; }
          else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules, (j) => (rule as CSSGroupingRule).deleteRule(j));
        }
      };
      for (const sheet of document.styleSheets) walk(sheet.cssRules, (i) => sheet.deleteRule(i));
      return n;
    }, process.env.STRESS_DROP_RULES);
    console.log("dropped rules:", dropped);
  }
  const presses: Press[] = [];
  for (let n = 1; n <= COUNT; n++) {
    const profile = process.env.STRESS_PROFILE && n === COUNT;
    const cdp = profile ? await crew.window.context().newCDPSession(crew.window) : null;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      await cdp.send("Profiler.start");
    }
    const tracing = process.env.STRESS_TRACE && n === COUNT ? await crew.window.context().newCDPSession(crew.window) : null;
    const events: { name: string; dur?: number; args?: Record<string, Record<string, unknown>> }[] = [];
    if (tracing) {
      tracing.on("Tracing.dataCollected", (e) => events.push(...(e.value as unknown as typeof events)));
      await tracing.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
    }
    presses.push(await press(crew, workspace.id, n));
    if (tracing) {
      const done = new Promise((resolve) => tracing.once("Tracing.tracingComplete", resolve));
      await tracing.send("Tracing.end");
      await done;
      const sums = new Map<string, { ms: number; n: number }>();
      for (const e of events) {
        if (!e.dur) continue;
        const s = sums.get(e.name) ?? { ms: 0, n: 0 };
        s.ms += e.dur / 1000;
        s.n++;
        sums.set(e.name, s);
      }
      console.log("trace:\n  " + [...sums].filter(([k]) => /Layout|Style|Paint|Composite|Layer|FunctionCall|EvaluateScript|RunTask|Prepaint|Hit/.test(k)).sort((a, b) => b[1].ms - a[1].ms).slice(0, 15).map(([k, v]) => `${v.ms.toFixed(1)}ms ×${v.n} ${k}`).join("\n  "));
      for (const e of events.filter((e) => (e.name === "UpdateLayoutTree" || e.name === "Layout") && (e.dur ?? 0) > 2000))
        console.log(" ", e.name, ((e.dur ?? 0) / 1000).toFixed(1), JSON.stringify(e.args).slice(0, 300));
    }
    if (cdp) {
      const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
      summarize(profile);
    }
  }

  const report = (slice: Press[]) => ({
    latency: stats(slice.map((p) => p.latency)),
    worstFrame: stats(slice.map((p) => p.worstFrame)),
    longTaskMs: stats(slice.map((p) => p.longTasks.reduce((a, b) => a + b, 0))),
    blankFrames: slice.reduce((sum, p) => sum + p.frames.filter((f) => f.shown === "none").length, 0),
    distinctStates: stats(slice.map((p) => new Set(p.frames.map((f) => (f as unknown as { detail: string }).detail)).size)),
    flickered: slice.filter((p) => p.frames.some((f) => f.shown === "none")).map((p) => p.n),
  });
  const buckets = [
    ["1-10", presses.slice(0, 10)],
    ["45-55", presses.slice(44, 55)],
    [`${COUNT - 9}-${COUNT}`, presses.slice(-10)],
  ] as const;
  for (const [label, slice] of buckets) console.log(`⌘N ${label}:`, JSON.stringify(report(slice)));
  const example = presses.find((p) => p.frames.some((f) => f.shown === "none"));
  if (example) console.log(`frames of press ${example.n}:`, JSON.stringify(example.frames.map((f) => f.shown)));
  for (const n of [2, 3, 50, COUNT]) {
    const p = presses[n - 1]!;
    const seq = p.frames.map((f) => (f as unknown as { detail: string }).detail);
    console.log(`press ${n} frames:\n  ` + seq.filter((d, i) => d !== seq[i - 1]).join("\n  "));
  }

  // Typing in the last chat, with every other one mounted behind it.
  const keys = await crew.window.evaluate(async () => {
    const area = [...document.querySelectorAll("textarea:not(.xterm-helper-textarea)")].find(
      (a) => (a as HTMLElement).offsetParent !== null,
    ) as HTMLTextAreaElement;
    area.focus();
    return true;
  });
  assert.ok(keys);
  const typing: number[] = [];
  for (const ch of "the quick brown fox jumps over") {
    const t0 = await crew.window.evaluate(() => performance.now());
    await crew.window.keyboard.type(ch);
    typing.push(
      await crew.window.evaluate(
        (t0) => new Promise<number>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0)))),
        t0,
      ),
    );
  }
  console.log("typing at", COUNT, "tabs:", JSON.stringify(stats(typing)));

  // Switching between tabs.
  const switches: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = await crew.window.evaluate(() => performance.now());
    await pressChord(crew, `${MOD}+Shift+BracketLeft`);
    switches.push(
      await crew.window.evaluate(
        (t0) => new Promise<number>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0)))),
        t0,
      ),
    );
  }
  console.log("tab switch at", COUNT, "tabs:", JSON.stringify(stats(switches)));
  const heap = await crew.window.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  console.log("heap MB:", Math.round(heap / 1e6), "DOM nodes:", await crew.window.evaluate(() => document.getElementsByTagName("*").length));
});

type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
};

/** Self and total time per function, the top of each. */
function summarize(profile: CpuProfile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const name = (id: number) => {
    const f = byId.get(id)!.callFrame;
    return `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
  };
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    self.set(name(id), (self.get(name(id)) ?? 0) + dt);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const key = name(at);
      if (seen.has(key)) continue;
      seen.add(key);
      total.set(key, (total.get(key) ?? 0) + dt);
    }
  });
  const top = (m: Map<string, number>, k: number) =>
    [...m].filter(([key]) => !/^\((root|program|idle|garbage collector)\)/.test(key)).sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, ms]) => `${ms.toFixed(1)}ms ${key}`);
  console.log("self:\n  " + top(self, 25).join("\n  "));
  console.log("total (components):\n  " + top(new Map([...total].filter(([k]) => /^[A-Z]/.test(k))), 40).join("\n  "));
}
