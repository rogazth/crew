// Stress: terminals opened with ⌘T ↵, one after another, in a heavy user's
// window (`seedHeavy`), over the first workspace's long chat. Each
// open is timed from the Enter to the first frame after the shell's first
// bytes, and split where it waits: the pane mounting, the spawn asked of
// crewd, crewd answering, the first bytes back. Past 16 terminals Chromium
// starts dropping WebGL contexts, so the count goes past that. Switching
// between them, and a reload that finds them, are timed too.
//
//   npm run e2e -- --stress terminals
//   STRESS_TERMINALS=30 npm run e2e -- --stress terminals
//   STRESS_EMPTY=1 …             → in a window with one empty workspace instead
//   STRESS_PROFILE=/some/dir …   → a .cpuprofile of the first, second and last opens
//   CREW_KEEP_NAMES=1 …          → the profiles name functions (the build keeps their names)
//
// Diagnostics only: nothing here fails on a number.
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { launchCrew, MOD, openLauncher, pressChord, waitFor, type Crew } from "../harness.ts";
import { seedHeavy } from "./heavy.ts";
import { probe, profiled, read, requestOf, reset, settle, stats } from "./probe.ts";

const COUNT = Number(process.env.STRESS_TERMINALS ?? 20);
const PROFILE = process.env.STRESS_PROFILE;

let crew: Crew;
const warnings: string[] = [];

before(async () => {
  crew = process.env.STRESS_EMPTY ? await launchCrew() : (await seedHeavy()).crew;
  await crew.app.context().addInitScript(probe);
  await crew.reload();
  crew.window.on("console", (message) => {
    const text = message.text();
    if (/webgl|context lost|too many active/i.test(text)) warnings.push(text.slice(0, 160));
  });
});

after(async () => {
  await crew?.close();
});

/**
 * Watches, frame by frame, for a terminal on screen that was not there before
 * the input, and for the second frame after the first PTY bytes: xterm parses
 * a write in a task and paints it on the frame after.
 */
async function arm(crew: Crew) {
  await crew.window.evaluate(() => {
    const w = window as unknown as { __seen: { mounted: number; painted: number }; __open: { firstFrame: number } };
    const known = new Set(document.querySelectorAll(".xterm"));
    const seen = { mounted: 0, painted: 0 };
    w.__seen = seen;
    let after = 0;
    const tick = () => {
      if (!seen.mounted) {
        for (const el of document.querySelectorAll(".xterm")) {
          if (!known.has(el) && el.checkVisibility()) seen.mounted = performance.now();
        }
      }
      if (seen.mounted && w.__open.firstFrame && ++after >= 2) {
        seen.painted = performance.now();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

type Open = {
  launcher: number;
  mounted: number;
  spawnSent: number;
  spawnAnswered: number;
  attachAnswered: number;
  firstBytes: number;
  painted: number;
  settled: number;
  longTaskMs: number;
  worstTask: number;
  /** What it fetched: each file as [name, from, to], from the input. */
  fetched?: [string, number, number][];
};

async function openOne(crew: Crew): Promise<Open> {
  const t0 = await reset(crew);
  await openLauncher(crew);
  const launcher = (await crew.window.evaluate(() => performance.now())) - t0;
  await reset(crew);
  await arm(crew);
  await crew.window.keyboard.press("Enter");
  const seen = await waitFor(
    () =>
      crew.window.evaluate(() => {
        const s = (window as unknown as { __seen: { mounted: number; painted: number } }).__seen;
        return s.painted ? s : null;
      }),
    { message: "the new terminal paints its shell", timeout: 30_000, interval: 20 },
  );
  const last = await settle(crew);
  const win = await read(crew);
  const since = win.input;
  const at = (t: number) => (t ? Math.round(t - since) : -1);
  const [spawnSent, spawnAnswered] = requestOf(win, "pty_spawn");
  const [, attachAnswered] = requestOf(win, "pty_attach");
  const tasks = win.longTasks.filter((l) => l.t >= since - 1);
  return {
    launcher: Math.round(launcher),
    mounted: at(seen.mounted),
    spawnSent: at(spawnSent),
    spawnAnswered: at(spawnAnswered),
    attachAnswered: at(attachAnswered),
    firstBytes: at(win.firstFrame),
    painted: at(seen.painted),
    settled: at(Math.max(last, seen.painted)),
    longTaskMs: Math.round(tasks.reduce((sum, l) => sum + l.d, 0)),
    worstTask: Math.round(tasks.reduce((max, l) => Math.max(max, l.d), 0)),
    ...(win.resources.length > 0 && { fetched: win.resources.map((r) => [r.name, at(r.t), at(r.end)] as [string, number, number]) }),
  };
}

function summary(opens: Open[]) {
  const keys = (Object.keys(opens[0] ?? {}) as (keyof Open)[]).filter((key) => key !== "fetched");
  return Object.fromEntries(keys.map((key) => [key, stats(opens.map((o) => o[key] as number))]));
}

/** Milliseconds from `t0` to the frame after the next task, the way a key is felt. */
function untilPainted(crew: Crew, t0: number): Promise<number> {
  return crew.window.evaluate(
    (t0) => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)))),
    t0,
  );
}

test(`${COUNT} terminals opened with ⌘T ↵, timed`, { timeout: 15 * 60_000 }, async (t: TestContext) => {
  const opens: Open[] = [];
  for (let n = 1; n <= COUNT; n++) {
    const profile = n === 1 || n === 2 || n === COUNT;
    if (profile) {
      const file = PROFILE ? path.join(PROFILE, `terminal-${n}.cpuprofile`) : undefined;
      const { value, top } = await profiled(crew, file, () => openOne(crew));
      opens.push(value);
      t.diagnostic(`terminal ${n}: ${JSON.stringify(value)}`);
      t.diagnostic(`terminal ${n} cpu: ${JSON.stringify(top)}`);
    } else opens.push(await openOne(crew));
  }
  t.diagnostic(`each (painted): ${JSON.stringify(opens.map((o) => o.painted))}`);
  t.diagnostic(`first open: ${JSON.stringify(opens[0])}`);
  t.diagnostic(`opens 2-${COUNT}: ${JSON.stringify(summary(opens.slice(1)))}`);

  // Stepping back through the terminals.
  const switches: number[] = [];
  for (let i = 0; i < Math.min(COUNT, 20); i++) {
    const t0 = await crew.window.evaluate(() => performance.now());
    await pressChord(crew, `${MOD}+Shift+BracketLeft`);
    switches.push(await untilPainted(crew, t0));
  }
  t.diagnostic(`tab switch at ${COUNT} terminals: ${JSON.stringify(stats(switches))}`);

  // A reload finds the terminal on screen again: timed to its first bytes.
  await openOne(crew);
  const reloads: number[] = [];
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    await crew.window.reload();
    await waitFor(
      () =>
        crew.window.evaluate(() => {
          const open = (window as unknown as { __open?: { firstFrame: number } }).__open;
          const shown = [...document.querySelectorAll(".xterm")].some((el) => el.checkVisibility());
          return shown && (open?.firstFrame ?? 0) > 0 ? performance.now() : 0;
        }),
      { message: "the reloaded terminal repaints", timeout: 30_000, interval: 20 },
    );
    reloads.push(Date.now() - started);
    await settle(crew);
  }
  t.diagnostic(`reload to terminal bytes: ${JSON.stringify(stats(reloads))}`);
  t.diagnostic(`webgl warnings: ${warnings.length} ${JSON.stringify(warnings.slice(0, 5))}`);
});
