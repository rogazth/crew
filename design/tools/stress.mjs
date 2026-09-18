/**
 * Measures a prototype under load.
 *
 * Builds it, serves the bundle, then for each scenario: opens the route, waits
 * for it to settle, scrolls the transcript hard, and records long tasks, dropped
 * frames, layout shift, JS heap and DOM size through the CDP.
 *
 * A prototype opts into the big fixtures with `?stress=<preset>` — if it ignores
 * the parameter the run still measures the demo data, which is a weaker but
 * still useful signal.
 *
 *   node tools/stress.mjs proto-ink
 *   node tools/stress.mjs --all --preset heavy
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildTo, closeServer, staticServer } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const designRoot = resolve(here, "..");
// Offset from the dev-server ports on purpose: a prototype being worked on
// holds 518x, and a tool run must never fight it for the socket.
const PORTS = { "proto-ink": 5281, "proto-console": 5282, "proto-canvas": 5283 };

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const PRESET = flag("preset", "heavy");

/** What we drive. `scroll` scenarios get the scroll storm. */
const SCENARIOS = [
  { id: "boot", hash: "#/session/s-harness", scroll: false },
  { id: "long-thread", hash: "#/session/s-daemon", scroll: true },
  { id: "stress-thread", hash: "#/session/stress-s-0", scroll: true, stress: true },
  { id: "sidebar", hash: "#/session/s-relay", scroll: false, stress: true },
  { id: "palette", hash: "#/session/s-harness", scroll: false, stress: true, palette: true },
  { id: "search", hash: "#/search", scroll: false, stress: true },
  { id: "routines", hash: "#/routines", scroll: false },
];

async function chromePath() {
  const base = join(process.env.HOME ?? "", ".cache/ms-playwright");
  for (const entry of await readdir(base)) {
    for (const candidate of [
      join(base, entry, "chrome-linux64/chrome"),
      join(base, entry, "chrome-linux/chrome"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("no chromium in the playwright cache");
}

/** Installs the observers before any app code runs. */
const PROBE = `
window.__probe = { longTasks: [], shifts: 0, frames: [], errors: [] };
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__probe.longTasks.push(Math.round(entry.duration));
  }).observe({ entryTypes: ["longtask"] });
} catch {}
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.__probe.shifts += entry.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
} catch {}
window.addEventListener("error", (e) => window.__probe.errors.push(String(e.message)));
`;

/** Scrolls the tallest scrollable box to the top and back, recording frame gaps. */
const SCROLL_STORM = `
(async () => {
  const boxes = [...document.querySelectorAll("*")].filter((el) => {
    const style = getComputedStyle(el);
    return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 200;
  });
  boxes.sort((a, b) => b.scrollHeight - a.scrollHeight);
  const box = boxes[0];
  if (!box) return { scrolled: 0, frames: [] };
  const frames = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const height = box.scrollHeight;
  const steps = 60;
  for (let i = 0; i <= steps; i += 1) {
    box.scrollTop = (height * i) / steps;
    await new Promise((r) => setTimeout(r, 16));
  }
  for (let i = steps; i >= 0; i -= 1) {
    box.scrollTop = (height * i) / steps;
    await new Promise((r) => setTimeout(r, 16));
  }
  running = false;
  await new Promise((r) => setTimeout(r, 50));
  return { scrolled: height, frames };
})()
`;

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]);
};

async function measure(page, port, scenario) {
  const query = scenario.stress ? `?stress=${PRESET}` : "";
  await page.goto(`http://localhost:${port}/${query}${scenario.hash}`, { waitUntil: "load" });
  await page.waitForTimeout(scenario.stress ? 1_800 : 900);

  if (scenario.palette) {
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(250);
    await page.keyboard.type("transcript", { delay: 12 });
    await page.waitForTimeout(400);
  }

  let frames = [];
  let scrolled = 0;
  if (scenario.scroll) {
    const result = await page.evaluate(SCROLL_STORM);
    frames = result.frames ?? [];
    scrolled = result.scrolled ?? 0;
  }

  const probe = await page.evaluate(() => ({
    longTasks: window.__probe?.longTasks ?? [],
    shifts: window.__probe?.shifts ?? 0,
    errors: window.__probe?.errors ?? [],
    nodes: document.getElementsByTagName("*").length,
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
    text: (document.getElementById("root")?.textContent ?? "").length,
  }));

  const longTotal = probe.longTasks.reduce((a, b) => a + b, 0);
  return {
    scenario: scenario.id,
    nodes: probe.nodes,
    heapMb: probe.heap,
    longTasks: probe.longTasks.length,
    longTotalMs: longTotal,
    longestMs: probe.longTasks.length ? Math.max(...probe.longTasks) : 0,
    cls: Number(probe.shifts.toFixed(4)),
    frameP50: percentile(frames, 50),
    frameP95: percentile(frames, 95),
    janky: frames.filter((f) => f > 32).length,
    scrolled,
    rendered: probe.text > 40,
    errors: [...new Set(probe.errors)].slice(0, 3),
  };
}

async function stressOne(name) {
  const cwd = join(designRoot, name);
  const port = PORTS[name];
  console.log(`\n══ ${name} ══`);
  const built = await buildTo(cwd, name);

  const server = await staticServer(built.dir, port);
  const browser = await chromium.launch({
    executablePath: await chromePath(),
    args: ["--enable-precise-memory-info"],
  });
  const rows = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(PROBE);
    const page = await context.newPage();
    for (const scenario of SCENARIOS) {
      const row = await measure(page, port, scenario);
      rows.push(row);
      const flags = [
        row.rendered ? "" : "EMPTY",
        row.longestMs > 200 ? `long ${row.longestMs}ms` : "",
        row.frameP95 > 40 ? `p95 ${row.frameP95}ms` : "",
        row.cls > 0.1 ? `cls ${row.cls}` : "",
        row.errors.length ? `${row.errors.length} error(s)` : "",
      ]
        .filter(Boolean)
        .join("  ");
      console.log(
        `  ${row.scenario.padEnd(15)} nodes ${String(row.nodes).padStart(6)}  ` +
          `heap ${String(row.heapMb ?? "–").padStart(4)}MB  ` +
          `longtasks ${String(row.longTasks).padStart(3)} (${String(row.longTotalMs).padStart(5)}ms)  ` +
          `frame p50/p95 ${String(row.frameP50).padStart(3)}/${String(row.frameP95).padStart(3)}ms  ` +
          (flags ? `⚠ ${flags}` : "ok"),
      );
      for (const error of row.errors) console.log(`      ${error.slice(0, 140)}`);
    }
    await context.close();
  } finally {
    await browser.close();
    await closeServer(server);
  }
  return rows;
}

const names = args.includes("--all")
  ? Object.keys(PORTS)
  : args.filter((a) => !a.startsWith("--") && a in PORTS);
const targets = names.length ? names : Object.keys(PORTS);

const report = {};
for (const name of targets) {
  try {
    report[name] = await stressOne(name);
  } catch (error) {
    console.error(`${name}: ${error.message}`);
    report[name] = { error: error.message };
  }
}

await mkdir(join(designRoot, "reports"), { recursive: true });
const out = join(designRoot, "reports", `stress-${PRESET}.json`);
await writeFile(out, JSON.stringify({ preset: PRESET, at: new Date().toISOString(), report }, null, 2));
console.log(`\nreport → ${out}`);
