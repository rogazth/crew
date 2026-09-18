/**
 * Screenshot a prototype without a display server.
 *
 * Builds the prototype, serves `dist/` with vite preview, drives the bundled
 * Playwright chromium, and writes PNGs into `<proto>/shots/`.
 *
 *   node tools/shoot.mjs proto-ink            # every route, both themes
 *   node tools/shoot.mjs proto-ink --light    # one theme
 *   node tools/shoot.mjs --all
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildTo, closeServer, staticServer } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const designRoot = resolve(here, "..");

// Offset from the dev-server ports on purpose: a prototype being worked on
// holds 518x, and a tool run must never fight it for the socket.
const PORTS = { "proto-ink": 5281, "proto-console": 5282, "proto-canvas": 5283 };

async function chromePath() {
  const base = join(process.env.HOME ?? "", ".cache/ms-playwright");
  if (!existsSync(base)) throw new Error(`no playwright browser cache at ${base}`);
  for (const entry of await readdir(base)) {
    const candidates = [
      join(base, entry, "chrome-linux64/chrome"),
      join(base, entry, "chrome-linux/chrome"),
      join(base, entry, "chrome-headless-shell-linux64/chrome-headless-shell"),
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  }
  throw new Error("no chromium binary found in the playwright cache");
}

/**
 * Routes are addressed through a hash so a prototype does not need a router:
 * each one reads `location.hash` on boot. A prototype that ignores it simply
 * screenshots its default surface several times, which is still useful.
 */
const ROUTES = [
  ["chat-long", "#/session/s-harness"],
  ["chat-agents", "#/session/s-relay"],
  ["chat-short", "#/session/s-renderer"],
  ["chat-empty", "#/session/s-triage"],
  ["chat-failed", "#/session/s-scribe"],
  ["chat-huge", "#/session/s-daemon"],
  ["terminal", "#/session/t-build"],
  ["file", "#/file/src/lib/tabs.ts"],
  ["search", "#/search"],
  ["routines", "#/routines"],
  ["settings", "#/settings/appearance"],
  ["keybindings", "#/settings/keybindings"],
  ["real-capture", "#/session/s-lead"],
  ["spawned-agent", "#/session/s-reviewer"],
];

/** Shot with the big fixtures, to show each design at a real workspace's size. */
const STRESS_ROUTES = [
  ["stress-sidebar", "?stress=heavy#/session/s-harness"],
  ["stress-thread", "?stress=heavy#/session/stress-s-0"],
];

async function shootOne(name, themes) {
  const cwd = join(designRoot, name);
  const port = PORTS[name];
  if (!port) throw new Error(`unknown prototype ${name}`);
  const shots = join(cwd, "shots");

  console.log(`\n── ${name} ──`);
  const built = await buildTo(cwd, name);
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });

  const server = await staticServer(built.dir, port);
  const browser = await chromium.launch({ executablePath: await chromePath() });
  try {
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));

      for (const [label, hash] of [...ROUTES, ...STRESS_ROUTES]) {
        await page.goto(`http://localhost:${port}/${hash}`, { waitUntil: "load" });
        // Give the app a beat to settle its first paint and any lazy surface.
        await page.waitForTimeout(hash.startsWith("?stress") ? 1_800 : 700);
        await page.screenshot({ path: join(shots, `${theme}-${label}.png`) });
      }
      await context.close();
      if (errors.length) {
        console.log(`  ${theme}: ${errors.length} console errors`);
        for (const error of [...new Set(errors)].slice(0, 8)) console.log(`    ${error}`);
      } else {
        console.log(`  ${theme}: clean`);
      }
    }
  } finally {
    await browser.close();
    await closeServer(server);
  }
  console.log(`  → ${shots}`);
}

const args = process.argv.slice(2);
const themes = args.includes("--light")
  ? ["light"]
  : args.includes("--dark")
    ? ["dark"]
    : ["light", "dark"];
const names = args.includes("--all")
  ? Object.keys(PORTS)
  : args.filter((a) => !a.startsWith("--"));

if (names.length === 0) {
  console.error("usage: node tools/shoot.mjs <proto-ink|proto-console|proto-canvas|--all> [--light|--dark]");
  process.exit(1);
}

for (const name of names) {
  try {
    await shootOne(name, themes);
  } catch (error) {
    console.error(`${name}: ${error.message}`);
  }
}
