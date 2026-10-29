// Stress: big files opened with ⌘P in a heavy user's window (`seedHeavy`).
// Each open is timed from the click on the palette's row to the first frame
// that shows the file's first line, with the read asked of crewd, the long
// tasks it ran (the freeze) and when it went quiet. Then, on a few of them:
// a jump to the last line, and typing at the top.
//
//   npm run e2e -- --stress big-files
//   STRESS_EMPTY=1 …             → in a window with one empty workspace instead
//   STRESS_PROFILE=/some/dir …   → a .cpuprofile of every open
//   CREW_KEEP_NAMES=1 …          → the profiles name more functions
//
// Diagnostics only: nothing here fails on a number.
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { launchCrew, MOD, pressChord, waitFor, type Crew } from "../harness.ts";
import { seedHeavy } from "./heavy.ts";
import { probe, profiled, read, requestOf, reset, settle, stats } from "./probe.ts";

const PROFILE = process.env.STRESS_PROFILE;

// ---------- the files ----------

const WORDS = ["session", "worktree", "terminal", "render", "frame", "buffer", "status", "update", "cursor", "window"];

/** TypeScript that tokenizes like real code: imports, types, functions, strings, comments. */
function code(lines: number, marker: string): string {
  const out = [`// ${marker}`, 'import { useEffect, useState } from "react";', ""];
  for (let i = 0; out.length < lines; i++) {
    const a = WORDS[i % WORDS.length]!;
    const b = WORDS[(i * 7 + 3) % WORDS.length]!;
    out.push(
      `/** Keeps the ${a} in step with the ${b}, once per frame. */`,
      `export function ${a}${i}(${b}: string, count = ${i}): { ${a}: string; total: number } {`,
      `  const label = \`${a}-\${${b}}-\${count}\`; // ${b} ${i}`,
      `  if (count > ${i % 97}) return { ${a}: label.toUpperCase(), total: count * ${i % 13} };`,
      `  return { ${a}: label, total: [1, 2, 3].reduce((sum, n) => sum + n, count) };`,
      "}",
      "",
    );
  }
  out.length = lines;
  return out.join("\n") + "\n";
}

function markdown(lines: number, marker: string): string {
  const out = [`# ${marker}`, ""];
  for (let i = 0; out.length < lines; i++) {
    const a = WORDS[i % WORDS.length]!;
    out.push(
      `## Section ${i}: the ${a}`,
      "",
      `The **${a}** keeps its state across a reload, and a \`${a}${i}\` call [reads it](https://example.com/${i}).`,
      `- one ${a}`,
      `- two ${WORDS[(i + 1) % WORDS.length]}`,
      "",
      ...(i % 5 === 0 ? ["```ts", `const ${a} = ${i};`, "```", ""] : []),
      ...(i % 7 === 0 ? ["| key | value |", "| --- | --- |", `| ${a} | ${i} |`, ""] : []),
    );
  }
  out.length = lines;
  return out.join("\n") + "\n";
}

function log(lines: number, marker: string): string {
  const out = [marker];
  for (let i = 1; i < lines; i++) {
    out.push(`2026-10-29T12:${String(i % 60).padStart(2, "0")}:00.${i % 1000}Z INFO [${WORDS[i % 10]}] request ${i} served in ${i % 300}ms`);
  }
  return out.join("\n") + "\n";
}

/** A whole JSON document on one line, as a minified bundle or an API dump is. */
function minified(bytes: number, marker: string): string {
  const items: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const item = `{"id":${i},"name":"${WORDS[i % 10]}-${i}","tags":["${WORDS[(i + 3) % 10]}","${WORDS[(i + 5) % 10]}"],"score":${(i * 37) % 1000}}`;
    items.push(item);
    size += item.length + 1;
  }
  return `{"marker":"${marker}","items":[${items.join(",")}]}\n`;
}

type Spec = { file: string; contents: string; kind: "code" | "note" };
const spec = (file: string, kind: Spec["kind"], make: (marker: string) => string): Spec => ({
  file,
  kind,
  contents: make(`marker-${path.basename(file).replace(/\W/g, "-")}`),
});

/** Smallest first: the first open also loads the editor. */
const FILES: Spec[] = [
  spec("code/warmup.ts", "code", (m) => code(40, m)),
  spec("code/small.ts", "code", (m) => code(500, m)),
  spec("code/medium.ts", "code", (m) => code(3_000, m)),
  // Just under TOKENIZE_MAX_LENGTH (300 kB): the biggest file that is highlighted.
  spec("code/edge.ts", "code", (m) => code(5_200, m)),
  // Typed into before its highlight is back.
  spec("code/early.ts", "code", (m) => code(3_000, m)),
  spec("code/large.ts", "code", (m) => code(20_000, m)),
  spec("code/huge.ts", "code", (m) => code(100_000, m)),
  spec("data/minified.json", "code", (m) => minified(2_000_000, m)),
  // Under crewd's 8 MB cap on what it reads as text.
  spec("logs/server.log", "code", (m) => log(100_000, m)),
  spec("docs/warmup.md", "note", (m) => markdown(40, m)),
  spec("docs/long.md", "note", (m) => markdown(3_000, m)),
  spec("docs/huge.md", "note", (m) => markdown(20_000, m)),
];

const markerOf = (s: Spec) => `marker-${path.basename(s.file).replace(/\W/g, "-")}`;

let crew: Crew;

before(async () => {
  const files = Object.fromEntries(FILES.map((f) => [f.file, f.contents]));
  crew = process.env.STRESS_EMPTY
    ? await launchCrew({ repos: [{ name: "app", files: { "README.md": "# app\n", ...files } }] })
    : (await seedHeavy({ files })).crew;
  await crew.app.context().addInitScript(probe);
  await crew.reload();
});

after(async () => {
  await crew?.close();
});

// ---------- the probe ----------

/** Watches, frame by frame, for the file's first line on screen. */
async function arm(crew: Crew, marker: string) {
  await crew.window.evaluate((marker) => {
    const w = window as unknown as { __shown: { at: number; highlighted: number } };
    const shown = { at: 0, highlighted: 0 };
    w.__shown = shown;
    const firstLine = (): Element | null => {
      for (const host of document.querySelectorAll("[data-code-editor] diffs-container")) {
        const line = host.shadowRoot?.querySelector('[data-line="1"][data-line-type]');
        if (line?.textContent?.includes(marker) && host.checkVisibility()) return line;
      }
      for (const note of document.querySelectorAll("[data-note-editor] .cm-line")) {
        if (note.textContent?.includes(marker) && note.checkVisibility()) return note;
      }
      return null;
    };
    const tick = () => {
      const line = firstLine();
      if (line && !shown.at) shown.at = performance.now();
      // Highlighted: the second line, an import, is split into token spans. The first is one comment.
      const next = line?.nextElementSibling;
      if (next && next.querySelectorAll("span[style]").length > 1) {
        shown.highlighted = performance.now();
        return;
      }
      if (shown.at && performance.now() - shown.at > 15_000) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, marker);
}

type Open = {
  file: string;
  kb: number;
  readSent: number;
  readAnswered: number;
  shown: number;
  highlighted: number;
  settled: number;
  longTaskMs: number;
  worstTask: number;
};

async function openFile(crew: Crew, s: Spec): Promise<Open> {
  await pressChord(crew, `${MOD}+p`);
  const palette = crew.window.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(s.file);
  const row = palette.getByRole("button", { name: s.file, exact: true });
  await row.waitFor();
  await reset(crew);
  await arm(crew, markerOf(s));
  await row.click();
  await waitFor(
    () => crew.window.evaluate(() => (window as unknown as { __shown: { at: number } }).__shown.at > 0),
    { message: `${s.file} on screen`, timeout: 60_000, interval: 20 },
  );
  // A code file under the plain-text cap is highlighted, maybe by the worker pool after it shows.
  if (s.kind === "code" && s.contents.length <= 300_000) {
    await waitFor(
      () => crew.window.evaluate(() => (window as unknown as { __shown: { highlighted: number } }).__shown.highlighted > 0),
      { message: `${s.file} highlighted`, timeout: 15_000, interval: 20 },
    ).catch(() => {});
  }
  const last = await settle(crew, 600);
  const win = await read(crew);
  const shown = await crew.window.evaluate(() => (window as unknown as { __shown: { at: number; highlighted: number } }).__shown);
  const since = win.input;
  const at = (t: number) => (t ? Math.round(t - since) : -1);
  const [readSent, readAnswered] = requestOf(win, "read_text_file");
  const tasks = win.longTasks.filter((l) => l.t >= since - 1);
  return {
    file: s.file,
    kb: Math.round(s.contents.length / 1024),
    readSent: at(readSent),
    readAnswered: at(readAnswered),
    shown: at(shown.at),
    highlighted: at(shown.highlighted),
    settled: at(Math.max(last, shown.at)),
    longTaskMs: Math.round(tasks.reduce((sum, l) => sum + l.d, 0)),
    worstTask: Math.round(tasks.reduce((max, l) => Math.max(max, l.d), 0)),
  };
}

/** Scrolls the file on screen to its end: ms until its last line is drawn. */
async function jumpToEnd(crew: Crew, s: Spec): Promise<number> {
  const lines = s.contents.split("\n").length - 1;
  const lastText = s.contents.split("\n")[lines - 1]!.slice(0, 40);
  return crew.window.evaluate(
    ([lines, lastText]) =>
      new Promise<number>((resolve, reject) => {
        const t0 = performance.now();
        const scroller =
          document.querySelector<HTMLElement>("[data-code-editor] > :first-child") ??
          [...document.querySelectorAll<HTMLElement>("[data-note-editor] .cm-scroller")].find((el) => el.checkVisibility());
        if (!scroller) return reject(new Error("no scroller"));
        scroller.scrollTop = scroller.scrollHeight;
        const drawn = () => {
          for (const host of document.querySelectorAll("[data-code-editor] diffs-container")) {
            if (host.shadowRoot?.querySelector(`[data-line="${lines}"][data-line-type]`)) return true;
          }
          return [...document.querySelectorAll("[data-note-editor] .cm-line")].some((l) => l.textContent?.includes(lastText));
        };
        const tick = () => {
          if (drawn()) return resolve(performance.now() - t0);
          if (performance.now() - t0 > 20_000) return reject(new Error("the last line never drew"));
          scroller.scrollTop = scroller.scrollHeight;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [lines, lastText] as const,
  );
}

/** Milliseconds from `t0` to the frame after the next task, the way a key is felt. */
function untilPainted(crew: Crew, t0: number): Promise<number> {
  return crew.window.evaluate(
    (t0) => new Promise<number>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0)))),
    t0,
  );
}

async function typeAtTop(crew: Crew, s: Spec): Promise<ReturnType<typeof stats>> {
  // The editor's text box is as tall as the file: its box on screen is the scroller.
  const scroller =
    s.kind === "code"
      ? crew.window.locator("[data-code-editor] > :first-child").filter({ visible: true })
      : crew.window.locator("[data-note-editor] .cm-scroller").filter({ visible: true });
  await scroller.click();
  await crew.window.keyboard.press(`${MOD}+ArrowUp`);
  const typing: number[] = [];
  for (const ch of "the quick brown fox") {
    const t0 = await crew.window.evaluate(() => performance.now());
    await crew.window.keyboard.type(ch);
    typing.push(await untilPainted(crew, t0));
  }
  return stats(typing);
}

test("big files opened with ⌘P, timed", { timeout: 20 * 60_000 }, async (t: TestContext) => {
  const opens: Open[] = [];
  for (const s of FILES.filter((f) => f.file !== "code/early.ts")) {
    const file = PROFILE ? path.join(PROFILE, `${path.basename(s.file)}.cpuprofile`) : undefined;
    const { value, top } = await profiled(crew, file, () => openFile(crew, s));
    opens.push(value);
    t.diagnostic(`${s.file}: ${JSON.stringify(value)}`);
    t.diagnostic(`${s.file} cpu: ${JSON.stringify(top.slice(0, 8))}`);
    if (!s.file.includes("warmup")) {
      const end = await jumpToEnd(crew, s).catch((e: Error) => `failed: ${e.message}`);
      t.diagnostic(`${s.file} jump to the end: ${typeof end === "number" ? Math.round(end) : end}ms`);
    }
    await pressChord(crew, `${MOD}+w`);
    await settle(crew);
  }

  // The same file again: its editor's state is kept for a while.
  const again = FILES.find((f) => f.file === "code/edge.ts")!;
  t.diagnostic(`code/edge.ts reopened: ${JSON.stringify(await openFile(crew, again))}`);

  // Typing before the highlight is back: the text holds, and the window does not freeze.
  const early = FILES.find((f) => f.file === "code/early.ts")!;
  await pressChord(crew, `${MOD}+p`);
  const palette = crew.window.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(early.file);
  await palette.getByRole("button", { name: early.file, exact: true }).click();
  await crew.window.getByRole("textbox", { name: "early.ts", exact: true }).waitFor();
  const typedEarly = await typeAtTop(crew, early);
  const held = await waitFor(
    () => crew.window.getByRole("textbox", { name: "early.ts", exact: true }).evaluate((el) => el.textContent?.includes("the quick brown fox")),
    { message: "the early typing holds", timeout: 5_000 },
  ).catch(() => false);
  t.diagnostic(`typing in code/early.ts before its highlight: ${JSON.stringify(typedEarly)}, text held: ${held}`);

  // Typing at the top of the biggest highlighted file, a plain one and a note.
  t.diagnostic(`typing in code/edge.ts: ${JSON.stringify(await typeAtTop(crew, again))}`);
  for (const file of ["code/huge.ts", "docs/huge.md"]) {
    const s = FILES.find((f) => f.file === file)!;
    await openFile(crew, s);
    t.diagnostic(`typing in ${file}: ${JSON.stringify(await typeAtTop(crew, s))}`);
  }

  t.diagnostic(`summary: ${JSON.stringify(opens.map((o) => [o.file, o.kb, o.shown, o.settled, o.worstTask]))}`);
});
