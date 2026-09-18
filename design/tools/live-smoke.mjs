/**
 * Does a prototype actually work against a real daemon?
 *
 * Starts its dev server (so the `crewd` Vite plugin is live), seeds the daemon
 * with a workspace and a couple of agents through the same socket the page will
 * use, then loads the page with `?source=live` and checks that the shell renders
 * the daemon's data rather than the fixtures'.
 *
 *   node tools/live-smoke.mjs proto-ink
 *   node tools/live-smoke.mjs --all
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const designRoot = resolve(here, "..");
const repoRoot = resolve(here, "../..");
// Dev-server ports of their own, so a prototype being worked on keeps 518x.
const PORTS = { "proto-ink": 5381, "proto-console": 5382, "proto-canvas": 5383 };

/** A name no fixture uses, so seeing it proves the page is on live data. */
const MARKER = "live-smoke-agent";

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

function devServer(cwd, port) {
  return new Promise((ok, fail) => {
    const child = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const done = () => !settled && ((settled = true), ok(child));
    child.stdout.on("data", (c) => /ready in|localhost:\d+/.test(String(c)) && done());
    child.on("exit", (code) => !settled && fail(new Error(`vite exited ${code}`)));
    setTimeout(done, 15_000);
  });
}

/** The daemon the plugin started, as the page will see it. */
async function daemonInfo(port) {
  const response = await fetch(`http://localhost:${port}/__crew/daemon`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

class Client {
  #ws;
  #next = 1;
  #pending = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.event) return;
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      message.ok ? waiter.ok(message.result) : waiter.fail(new Error(message.error));
    });
  }

  static async open(info) {
    const ws = new WebSocket(info.url);
    await new Promise((ok, fail) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", () => fail(new Error("socket error")), { once: true });
    });
    ws.send(JSON.stringify({ auth: info.token }));
    return new Client(ws);
  }

  request(method, params = {}) {
    const id = this.#next++;
    return new Promise((ok, fail) => {
      this.#pending.set(id, { ok, fail });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        fail(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  close() {
    this.#ws.close();
  }
}

async function seed(info) {
  const client = await Client.open(info);
  const existing = await client.request("workspace_list");
  const workspace =
    existing.find((w) => w.name === "live-smoke") ??
    (await client.request("workspace_create", { name: "live-smoke", path: repoRoot }));
  const sessions = await client.request("session_list", { workspaceId: workspace.id });
  if (!sessions.some((s) => s.name === MARKER)) {
    await client.request("session_create", {
      workspaceId: workspace.id,
      kind: "agent",
      name: MARKER,
      provider: "claude",
      model: "claude-opus-5",
      description: "Created by the live smoke test. Never spoken to.",
      autonomy: "ask",
    });
    await client.request("session_create", {
      workspaceId: workspace.id,
      kind: "terminal",
      name: "live-smoke-shell",
      provider: "claude",
      model: "",
      description: "",
      autonomy: "ask",
    });
  }
  client.close();
  return workspace;
}

async function check(name) {
  const cwd = join(designRoot, name);
  const port = PORTS[name];
  console.log(`\n── ${name}`);
  const server = await devServer(cwd, port);
  const problems = [];
  let browser;
  try {
    const info = await daemonInfo(port);
    console.log(`  daemon  ${info.url}`);
    await seed(info);
    console.log("  seeded  1 workspace, 2 sessions");

    browser = await chromium.launch({ executablePath: await chromePath() });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    await page.goto(`http://localhost:${port}/?source=live`, { waitUntil: "load" });
    // The shell has to fetch discovery, open a socket, authenticate and list.
    await page.waitForFunction(
      (marker) => (document.body.textContent ?? "").includes(marker),
      MARKER,
      { timeout: 25_000 },
    ).catch(() => problems.push("the live agent never appeared in the shell"));

    const text = await page.evaluate(() => document.body.textContent ?? "");
    const shows = (needle) => text.includes(needle);

    console.log(`  ${shows(MARKER) ? "✓" : "✕"} live session renders in the shell`);
    // The fixture world must be gone: seeing `Relay` means it fell back.
    console.log(`  ${shows("Relay") ? "✕ fixtures leaked through" : "✓ no fixture data"}`);
    if (shows("Relay")) problems.push("fixture data rendered in live mode");

    const badge = /Live daemon|live/i.test(text);
    console.log(`  ${badge ? "✓" : "○"} source badge visible`);

    // And the fixture mode still works with the same build.
    await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
    await page.waitForTimeout(1_200);
    const back = await page.evaluate(() => document.body.textContent ?? "");
    const fine = back.includes("Relay") || back.includes("harness");
    console.log(`  ${fine ? "✓" : "✕"} fixture mode still works`);
    if (!fine) problems.push("fixture mode broke");

    const unique = [...new Set(errors)];
    if (unique.length) {
      console.log(`  ✕ ${unique.length} console error(s)`);
      for (const error of unique.slice(0, 5)) console.log(`      ${error.slice(0, 160)}`);
      problems.push(`${unique.length} console errors`);
    } else {
      console.log("  ✓ no console errors");
    }
  } catch (error) {
    console.log(`  ✕ ${error.message.split("\n")[0]}`);
    problems.push(error.message);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    // The plugin reaps its daemon when the server's socket closes; give it a beat.
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(problems.length === 0 ? "  → live mode works" : `  → ${problems.length} problem(s)`);
  return problems.length === 0;
}

const args = process.argv.slice(2);
const names = args.includes("--all")
  ? Object.keys(PORTS)
  : args.filter((a) => a in PORTS);
const targets = names.length ? names : Object.keys(PORTS);

let ok = true;
for (const name of targets) ok = (await check(name)) && ok;
process.exit(ok ? 0 : 1);
