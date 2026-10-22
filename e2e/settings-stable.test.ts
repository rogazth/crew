// Settings › every page: a page paints once, as it will stay. Nothing moves
// below what is already shown (no row appears late, no switch flips from its
// default to the saved value) in the frames after the nav lands on it, the
// first time or on a return.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchCrew, MOD, pressChord, type Crew } from "./harness.ts";

const PAGES = ["General", "Appearance", "Notifications", "Terminal", "Browser", "Environments", "Providers", "Usage", "Keybindings", "About"];

type Frame = { title: string; rows: string; switches: string };

/** Runs `go` and records, each frame for `ms`, where the page's rows sit and how its switches read. */
async function watch(crew: Crew, go: () => Promise<void>, ms = 1500): Promise<Frame[]> {
  const page = crew.window;
  await page.evaluate((ms) => {
    const w = window as unknown as { frames_: Frame[]; done_: Promise<void> };
    w.frames_ = [];
    w.done_ = new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        const main = document.querySelector("main") ?? document.body;
        const rows = [...main.querySelectorAll("[data-setting], section, h1")]
          .map((el) => {
            const box = el.getBoundingClientRect();
            return `${el.getAttribute("data-setting") ?? el.tagName}@${Math.round(box.top)}:${Math.round(box.height)}`;
          })
          .join(" ");
        const switches = [...main.querySelectorAll('[role="switch"]')]
          .map((el) => el.getAttribute("aria-checked"))
          .join(",");
        const title = [...main.querySelectorAll("h1")].map((el) => el.textContent).join("|");
        w.frames_.push({ title, rows, switches });
        if (performance.now() - start < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    type Frame = { title: string; rows: string; switches: string };
  }, ms);
  await go();
  return page.evaluate(async () => {
    const w = window as unknown as { frames_: Frame[]; done_: Promise<void> };
    await w.done_;
    return w.frames_;
  });
}

/** Changes after the first frame that shows the page's title. */
function shifts(frames: Frame[], label: string, name: string): string[] {
  const shown = frames.findIndex((frame) => frame.title.split("|").includes(name));
  if (shown < 0) return [`${label}: never showed ${name}`];
  const out: string[] = [];
  for (let i = Math.max(shown, 0) + 1; i < frames.length; i++) {
    const before = frames[i - 1]!;
    const after = frames[i]!;
    if (before.rows !== after.rows) out.push(`${label} frame ${i}: rows\n  ${before.rows}\n  ${after.rows}`);
    if (before.switches !== after.switches) out.push(`${label} frame ${i}: switches ${before.switches} -> ${after.switches}`);
  }
  return out;
}

test("S1: every settings page paints once, first visit and return", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  await crew.request("state_set", { key: "sessions:bypass-permissions", value: "on" });
  const found = shifts(await watch(crew, () => pressChord(crew, `${MOD}+,`)), "open", "General");
  for (const round of [1, 2]) {
    for (const label of [...PAGES.slice(1), PAGES[0]!]) {
      const click = () => crew.window.getByRole("button", { name: label, exact: true }).click();
      found.push(...shifts(await watch(crew, click), `round ${round} ${label}`, label));
    }
  }
  assert.deepEqual(found, []);
});
