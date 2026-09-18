/**
 * Gate for all three prototypes: typecheck, build, then boot the built bundle in
 * headless chromium and walk every route looking for console errors and an empty
 * root. Exits non-zero if any prototype fails.
 *
 *   node tools/smoke.mjs            # all three
 *   node tools/smoke.mjs proto-ink
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildTo, closeServer, staticServer } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const designRoot = resolve(here, "..");
// Offset from the dev-server ports on purpose: a prototype being worked on
// holds 518x, and a tool run must never fight it for the socket.
const PORTS = { "proto-ink": 5281, "proto-console": 5282, "proto-canvas": 5283 };

const ROUTES = [
  "#/session/s-harness",
  "#/session/s-relay",
  "#/session/s-renderer",
  "#/session/s-triage",
  "#/session/s-scribe",
  "#/session/s-daemon",
  "#/session/t-build",
  "#/file/src/lib/tabs.ts",
  "#/search",
  "#/routines",
  "#/settings/appearance",
  "#/settings/keybindings",
  "#/nonsense/route",
];

async function chromePath() {
  const base = join(process.env.HOME ?? "", ".cache/ms-playwright");
  for (const entry of await readdir(base)) {
    for (const candidate of [
      join(base, entry, "chrome-linux64/chrome"),
      join(base, entry, "chrome-linux/chrome"),
      join(base, entry, "chrome-headless-shell-linux64/chrome-headless-shell"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("no chromium in the playwright cache");
}

function capture(cmd, args, cwd) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => ok({ code, out }));
  });
}

async function smoke(name) {
  const cwd = join(designRoot, name);
  const port = PORTS[name];
  const problems = [];
  process.stdout.write(`\n── ${name}\n`);

  const tsc = await capture("npx", ["tsc", "--noEmit"], cwd);
  console.log(`  tsc    ${tsc.code === 0 ? "ok" : "FAIL"}`);
  if (tsc.code !== 0) {
    problems.push("tsc");
    console.log(tsc.out.split("\n").slice(0, 25).map((l) => `    ${l}`).join("\n"));
  }

  let built;
  try {
    built = await buildTo(cwd, name);
    console.log("  build  ok");
  } catch (error) {
    console.log("  build  FAIL");
    problems.push("build");
    console.log(String(error.message).split("\n").slice(-20).map((l) => `    ${l}`).join("\n"));
    return problems;
  }

  const bytes = /index-\w+\.js\s+([\d.]+)\s*kB/.exec(built.output);
  if (bytes) console.log(`  bundle ${bytes[1]} kB`);

  const server = await staticServer(built.dir, port);
  const browser = await chromium.launch({ executablePath: await chromePath() });
  try {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

      for (const route of ROUTES) {
        await page.goto(`http://localhost:${port}/${route}`, { waitUntil: "load" });
        await page.waitForTimeout(450);
        const filled = await page.evaluate(
          () => (document.getElementById("root")?.textContent ?? "").trim().length,
        );
        if (filled < 20) {
          problems.push(`${theme} ${route}: root nearly empty`);
          console.log(`  ✕ ${theme} ${route} — root nearly empty`);
        }
      }
      const unique = [...new Set(errors)];
      if (unique.length) {
        problems.push(`${theme}: ${unique.length} console errors`);
        console.log(`  ✕ ${theme} — ${unique.length} console errors`);
        for (const error of unique.slice(0, 6)) console.log(`      ${error.slice(0, 160)}`);
      } else {
        console.log(`  ✓ ${theme} — ${ROUTES.length} routes, no console errors`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await closeServer(server);
  }
  return problems;
}

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = names.length ? names : Object.keys(PORTS);
let failed = false;
for (const name of targets) {
  const problems = await smoke(name);
  if (problems.length) {
    failed = true;
    console.log(`  → ${problems.length} problem(s)`);
  } else {
    console.log("  → clean");
  }
}
process.exit(failed ? 1 : 0);
