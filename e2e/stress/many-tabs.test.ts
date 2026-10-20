// Stress: 100 sessions opened with ⌘N, one after another, in one window. Each
// press is timed from the key to the first frame that shows the new chat's
// composer, and every frame in between is recorded: a frame with no composer
// on screen is the flicker, and the test fails on one. Typing in the 100th
// chat and stepping through the tabs are timed as diagnostics.
//
//   npm run e2e -- --stress many-tabs
//   STRESS_TABS=30 npm run e2e -- --stress many-tabs
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
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
  await crew.window.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ids = new WeakMap<Element, number>();
    let next = 1;
    const frames: Frame[] = [];
    const longTasks: { t: number; d: number }[] = [];
    w.__frames = frames;
    w.__longTasks = longTasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push({ t: entry.startTime, d: entry.duration });
    }).observe({ type: "longtask", buffered: false });
    const tick = (t: number) => {
      let shown = "none";
      for (const area of document.querySelectorAll("textarea:not(.xterm-helper-textarea)")) {
        if ((area as HTMLElement).offsetParent === null) continue;
        if (!ids.has(area)) ids.set(area, next++);
        shown = String(ids.get(area));
        break;
      }
      frames.push({ t, shown });
      if (frames.length > 4000) frames.splice(0, 2000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function press(crew: Crew, workspaceId: string, n: number): Promise<Press> {
  const known = new Set((await sessions(crew, workspaceId)).map((s) => s.id));
  const [t0, before] = await crew.window.evaluate(() => {
    const w = window as unknown as { __frames: Frame[] };
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
          const w = window as unknown as { __frames: Frame[]; __longTasks: { t: number; d: number }[] };
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

/** Milliseconds from `t0` to the frame after the next task, the way a key is felt. */
function untilPainted(crew: Crew, t0: number): Promise<number> {
  return crew.window.evaluate(
    (t0) => new Promise<number>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0)))),
    t0,
  );
}

test(`${COUNT} sessions opened with ⌘N, timed`, { timeout: 15 * 60_000 }, async (t: TestContext) => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await record(crew);
  const presses: Press[] = [];
  for (let n = 1; n <= COUNT; n++) presses.push(await press(crew, workspace.id, n));

  const report = (slice: Press[]) => ({
    latency: stats(slice.map((p) => p.latency)),
    worstFrame: stats(slice.map((p) => p.worstFrame)),
    longTaskMs: stats(slice.map((p) => p.longTasks.reduce((a, b) => a + b, 0))),
  });
  const buckets = [
    ["1-10", presses.slice(0, 10)],
    ["45-55", presses.slice(44, 55)],
    [`${COUNT - 9}-${COUNT}`, presses.slice(-10)],
  ] as const;
  for (const [label, slice] of buckets) t.diagnostic(`⌘N ${label}: ${JSON.stringify(report(slice))}`);

  // A frame with no composer on screen between two chats is the flicker.
  const flickered = presses.filter((p) => p.frames.some((f) => f.shown === "none")).map((p) => p.n);
  assert.deepEqual(flickered, [], "presses that showed a frame with no composer");

  // Typing in the last chat, with every other one mounted behind it.
  await crew.window.evaluate(() => {
    const area = [...document.querySelectorAll("textarea:not(.xterm-helper-textarea)")].find(
      (a) => (a as HTMLElement).offsetParent !== null,
    ) as HTMLTextAreaElement;
    area.focus();
  });
  const typing: number[] = [];
  for (const ch of "the quick brown fox jumps over") {
    const t0 = await crew.window.evaluate(() => performance.now());
    await crew.window.keyboard.type(ch);
    typing.push(await untilPainted(crew, t0));
  }
  t.diagnostic(`typing at ${COUNT} tabs: ${JSON.stringify(stats(typing))}`);

  // Switching between tabs.
  const switches: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = await crew.window.evaluate(() => performance.now());
    await pressChord(crew, `${MOD}+Shift+BracketLeft`);
    switches.push(await untilPainted(crew, t0));
  }
  t.diagnostic(`tab switch at ${COUNT} tabs: ${JSON.stringify(stats(switches))}`);
});
