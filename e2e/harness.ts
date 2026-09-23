// Launches the real app under Playwright: the built renderer, the debug crewd, a
// throwaway data directory and one seeded workspace. The guest helpers drive
// <webview> contents from the main process, which is where Electron exposes them.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import type { DaemonInfo } from "../src/lib/host.ts";
import type { Workspace } from "../src/lib/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// In Node the electron package exports the path to its binary.
const ELECTRON: string = createRequire(import.meta.url)("electron");

export type Crew = {
  app: ElectronApplication;
  window: Page;
  dataDir: string;
  workspaceDir: string;
  /** A crewd RPC over the harness's own connection. */
  request<T = unknown>(method: string, params?: object): Promise<T>;
  close(): Promise<void>;
};

export type LaunchOptions = {
  /** Name of the seeded workspace. */
  workspace?: string;
  /**
   * A directory to keep the data and the workspace in, so a second launch on it
   * can check what was restored. The caller owns it: it is not removed on
   * close, and a workspace already active in it is kept instead of seeding.
   */
  dir?: string;
};

export async function launchCrew(opts: LaunchOptions = {}): Promise<Crew> {
  const root = opts.dir ?? (await mkdtemp(path.join(tmpdir(), "crew-e2e-")));
  const dataDir = path.join(root, "data");
  let workspaceDir = path.join(root, "work");
  await mkdir(workspaceDir, { recursive: true });
  const cleanup = async () => {
    if (opts.dir) return;
    if (process.env.E2E_KEEP === "1") console.log(`e2e: kept ${root}`);
    else await rm(root, { recursive: true, force: true, maxRetries: 3 });
  };

  let app: ElectronApplication;
  try {
    // executablePath keeps Playwright's loader out, and with it the Chromium
    // switches it appends (no background throttling among them): the app runs
    // as it ships. Linux has no usable sandbox under Xvfb.
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [ROOT, `--user-data-dir=${dataDir}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
      env: { ...process.env, CREW_RENDERER: "dist" },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  let rpc: Rpc | null = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    rpc?.close();
    await quit(app);
    await cleanup();
  };

  try {
    const page = await app.firstWindow();
    // The first window can still be on about:blank, before the preload runs.
    await page.waitForFunction(() => Boolean(window.crewHost));
    const info = await page.evaluate(() => {
      if (!window.crewHost) throw new Error("the preload did not expose crewHost");
      return window.crewHost.daemonInfo();
    });
    rpc = await connect(info);
    const { request } = rpc;

    const active = await request<string | null>("active_workspace_get");
    const workspaces = await request<Workspace[]>("workspace_list");
    const existing = workspaces.find((workspace) => workspace.id === active);
    if (existing) {
      workspaceDir = existing.path;
    } else {
      const created = await request<Workspace>("workspace_create", {
        name: opts.workspace ?? "e2e",
        path: workspaceDir,
      });
      await request("active_workspace_set", { id: created.id });
    }

    // The renderer read the workspace list before there was one.
    await page.reload();
    await page.locator('[data-sidebar="sidebar"]').waitFor({ state: "visible" });
    await tabBar(page).waitFor({ state: "visible" });

    return { app, window: page, dataDir, workspaceDir, request, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The strip holding the tabs and the new-tab button. The tablist alone has no
 * size while a workspace has no tabs, so it never counts as visible.
 */
export function tabBar(page: Page) {
  return page.locator('[role="tablist"]').first().locator("..");
}

async function quit(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  // Quitting stops crewd first; the timeout is only for an app that hangs.
  const done = app.close().then(() => true, () => false);
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000).unref());
  if (await Promise.race([done, timeout])) return;
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  // crewd exits on its own once its stdin, the dead app's pipe, closes.
}

type Rpc = { request: Crew["request"]; close(): void };

// Same framing as the renderer's transport: authenticate, then JSON requests
// matched to responses by id. Events and binary terminal frames are ignored.
async function connect(info: DaemonInfo): Promise<Rpc> {
  const ws = new WebSocket(info.url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`could not reach crewd at ${info.url}`)), { once: true });
  });
  ws.send(JSON.stringify({ auth: info.token }));

  type Waiter = { resolve(value: unknown): void; reject(error: Error): void };
  const pending = new Map<number, Waiter>();
  let nextId = 1;
  ws.addEventListener("message", (message: MessageEvent) => {
    if (typeof message.data !== "string") return;
    const parsed = JSON.parse(message.data) as { id?: number; ok?: boolean; result?: unknown; error?: string };
    if (parsed.id === undefined) return;
    const waiter = pending.get(parsed.id);
    if (!waiter) return;
    pending.delete(parsed.id);
    if (parsed.ok) waiter.resolve(parsed.result);
    else waiter.reject(new Error(parsed.error ?? "request failed"));
  });
  ws.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("crewd closed the connection"));
    pending.clear();
  });

  const request = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { request, close: () => ws.close() };
}

export type Guest = { id: number; url: string };

/** Every <webview> guest the app has, by webContents id. */
export function guests(app: ElectronApplication): Promise<Guest[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "webview")
      .map((contents) => ({ id: contents.id, url: contents.getURL() })),
  );
}

/**
 * Runs `js` in the guest. Back and forward skip history entries created
 * without a user gesture, so a navigation a test will go back from has to pass
 * `userGesture = true`.
 */
export function guestEval<T = unknown>(
  app: ElectronApplication,
  id: number,
  js: string,
  userGesture = false,
): Promise<T> {
  return app.evaluate(
    ({ webContents }, arg) => {
      const contents = webContents.fromId(arg.id);
      if (!contents) throw new Error(`no webContents ${arg.id}`);
      return contents.executeJavaScript(arg.js, arg.userGesture);
    },
    { id, js, userGesture },
  ) as Promise<T>;
}

export type Modifier = "shift" | "control" | "alt" | "meta";

/** The app's command modifier: ⌘ on macOS, Ctrl elsewhere. */
export const MOD: Modifier = process.platform === "darwin" ? "meta" : "control";

export type Keypress = {
  /**
   * An accelerator key code: "l", "[", "Escape". Electron derives the DOM
   * `code` from it as if on a US layout; sendInputEvent takes no code.
   */
  key: string;
  modifiers?: Modifier[];
};

/**
 * Focuses the guest and sends the key through its input pipeline, so it passes
 * `before-input-event` exactly like a real keypress.
 */
export function pressInGuest(app: ElectronApplication, id: number, press: Keypress): Promise<void> {
  return app.evaluate(
    ({ webContents }, { id, key, modifiers }) => {
      const contents = webContents.fromId(id);
      if (!contents) throw new Error(`no webContents ${id}`);
      contents.focus();
      contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
      // Only a printable key without a command modifier types a character.
      const typing = key.length === 1 && !modifiers.some((mod) => mod !== "shift");
      if (typing) contents.sendInputEvent({ type: "char", keyCode: key, modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    },
    { id, key: press.key, modifiers: press.modifiers ?? [] },
  );
}

export function crashGuest(app: ElectronApplication, id: number): Promise<void> {
  return app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (!contents) throw new Error(`no webContents ${id}`);
    contents.forcefullyCrashRenderer();
  }, id);
}

type Counters = Map<number, { count: number; stop(): void }>;

/**
 * Counts a guest's webContents event from the main side, e.g. did-start-loading
 * to prove something did not reload. `stop()` detaches and returns the count.
 */
export async function countEvents(
  app: ElectronApplication,
  id: number,
  eventName: string,
): Promise<{ stop(): Promise<number> }> {
  const key = await app.evaluate(
    ({ webContents }, { id, eventName }) => {
      const contents = webContents.fromId(id);
      if (!contents) throw new Error(`no webContents ${id}`);
      const scope = globalThis as { __e2eCounters?: Counters; __e2eNext?: number };
      const counters = (scope.__e2eCounters ??= new Map());
      const key = (scope.__e2eNext = (scope.__e2eNext ?? 0) + 1);
      const counter = { count: 0, stop: () => {} };
      const listener = () => {
        counter.count += 1;
      };
      // The typed overloads only take known event names.
      const emitter: NodeJS.EventEmitter = contents;
      emitter.on(eventName, listener);
      counter.stop = () => emitter.off(eventName, listener);
      counters.set(key, counter);
      return key;
    },
    { id, eventName },
  );
  return {
    stop: () =>
      app.evaluate((_, key) => {
        const counters = (globalThis as { __e2eCounters?: Counters }).__e2eCounters;
        const counter = counters?.get(key);
        if (!counter) throw new Error(`no counter ${key}`);
        counter.stop();
        counters?.delete(key);
        return counter.count;
      }, key),
  };
}

/** Polls until `fn` returns something truthy, retrying through throws. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  { timeout = 5000, interval = 50 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const until = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= until) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`waitFor gave up after ${timeout}ms; last: ${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
