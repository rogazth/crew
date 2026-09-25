// Launches the real app under Playwright: the built renderer, the debug crewd,
// and a sandbox that stands in for the user's machine. HOME, XDG_CONFIG_HOME
// (and with it userData, `config/Crew Dev`) and the git repos all live in one
// short temporary directory: crewd's Unix socket sits in userData, and a long
// path fails with "path must be shorter than SUN_LEN". A fake `claude` in
// $HOME/.local/bin, where crewd looks first, plays the provider CLI.
import { execFile } from "node:child_process";
import { chmod, mkdir, symlink, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import type { DaemonInfo } from "../src/lib/host.ts";
import type { Session, Workspace } from "../src/lib/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// In Node the electron package exports the path to its binary.
const ELECTRON: string = createRequire(import.meta.url)("electron");
const FAKE_CLAUDE = path.join(ROOT, "e2e/bin/claude");
const run = promisify(execFile);

export type Modifier = "Shift" | "Control" | "Alt" | "Meta";

/** The app's command modifier, as Playwright spells it: ⌘ on macOS, Ctrl elsewhere. */
export const MOD: Modifier = process.platform === "darwin" ? "Meta" : "Control";

export type Repo = { name: string; files?: Record<string, string> };

export type LaunchOptions = {
  /**
   * A sandbox from an earlier launch, to relaunch on the same data. The caller
   * owns it: it is kept on close, and no workspace is seeded into it.
   */
  dir?: string;
  /**
   * Git repos made under `repos/` and opened as workspaces, the first one
   * active. Defaults to one repo, `app`. Ignored with `dir`.
   */
  repos?: (string | Repo)[];
};

export type Crew = {
  app: ElectronApplication;
  window: Page;
  /** The sandbox root: `home/`, `config/`, `repos/`. */
  root: string;
  home: string;
  /** Electron's userData, where crewd keeps its database and socket. */
  userData: string;
  /** Workspaces seeded at launch, in order; the first is the active one. */
  workspaces: Workspace[];
  /**
   * A crewd RPC over the harness's own connection. When crewd restarts (the app
   * brings it back once after a crash, on a new port and token), the next call
   * connects to the new one.
   */
  request<T = unknown>(method: string, params?: object): Promise<T>;
  /** Reloads the window, as ⌘⇧R does, and waits for it to paint. */
  reload(): Promise<void>;
  /** Runs git with the sandbox's HOME, so its .gitconfig applies. Resolves to trimmed stdout. */
  git(cwd: string, ...args: string[]): Promise<string>;
  /** A real git repo with one commit, under `repos/`. */
  makeRepo(name: string, files?: Record<string, string>): Promise<string>;
  /** Opens `dir` as a workspace, makes it active and reloads the window onto it. */
  addWorkspace(dir: string, name?: string): Promise<Workspace>;
  /** Every launch of the fake claude so far, oldest first. */
  claudeLaunches(): Promise<ClaudeLaunch[]>;
  /**
   * Quits the app the way a user does and launches it again on the same data.
   * The sandbox passes to the new Crew: close that one, not this. `between`
   * runs while the app is down, on the data as the quit left it.
   */
  restart(between?: () => Promise<void>): Promise<Crew>;
  close(): Promise<void>;
};

export type ClaudeLaunch = { argv: string[]; cwd: string; pid: number; at: number };

export async function launchCrew(opts: LaunchOptions = {}): Promise<Crew> {
  return launch(opts, opts.dir === undefined);
}

/** `owns`: the sandbox is deleted on close, unless a restart handed it on. */
async function launch(opts: LaunchOptions, owns: boolean): Promise<Crew> {
  const root = opts.dir ?? (await mkdtemp("/tmp/ce-"));
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const repos = path.join(root, "repos");
  const userData = path.join(config, "Crew Dev");
  const env = sandboxEnv(home, config);

  let handedOff = false;
  const cleanup = async () => {
    if (!owns || handedOff) return;
    if (process.env.E2E_KEEP === "1") console.log(`e2e: kept ${root}`);
    else await rm(root, { recursive: true, force: true, maxRetries: 3 });
  };

  const git = async (cwd: string, ...args: string[]) => {
    const { stdout } = await run("git", args, { cwd, env });
    return stdout.trim();
  };
  const makeRepo = async (name: string, files: Record<string, string> = { "README.md": `# ${name}\n` }) => {
    const dir = path.join(repos, name);
    await mkdir(dir, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), contents);
    }
    await git(dir, "init", "--quiet");
    await git(dir, "add", "--all");
    await git(dir, "commit", "--quiet", "--message", "initial");
    return dir;
  };

  const seeded: string[] = [];
  try {
    await prepareSandbox(home, config, repos);
    if (!opts.dir) {
      for (const repo of opts.repos ?? ["app"]) {
        const { name, files } = typeof repo === "string" ? { name: repo, files: undefined } : repo;
        seeded.push(await makeRepo(name, files));
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  let app: ElectronApplication;
  try {
    // executablePath keeps Playwright's loader out, and with it the Chromium
    // switches it appends (no background throttling among them): the app runs
    // as it ships. Linux has no usable sandbox under Xvfb.
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [ROOT, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
      env: { ...env, CREW_RENDERER: "dist" },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  let rpc: Rpc | null = null;
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    rpc?.close();
    await quit(app, () => killStragglers(home));
  };
  const close = async () => {
    await shutdown();
    await cleanup();
  };
  const restart = async (between?: () => Promise<void>) => {
    await shutdown();
    await between?.();
    handedOff = true;
    return launch({ dir: root }, owns);
  };

  try {
    const page = await app.firstWindow();
    // The first window can still be on about:blank, before the preload runs.
    await page.waitForFunction(() => Boolean(window.crewHost));
    const info = await page.evaluate(() => {
      if (!window.crewHost) throw new Error("the preload did not expose crewHost");
      return window.crewHost.daemonInfo();
    });
    rpc = await rpcFor(page, info);
    const { request } = rpc;
    const reload = async () => {
      await page.reload();
      await ready(page);
    };

    const addWorkspace = async (dir: string, name = path.basename(dir)) => {
      const created = await request<Workspace>("workspace_create", { name, path: dir });
      await request("active_workspace_set", { id: created.id });
      // The renderer read the workspace list before this one existed.
      await page.reload();
      await ready(page);
      return created;
    };

    const workspaces: Workspace[] = [];
    if (seeded.length > 0) {
      for (const dir of seeded) {
        workspaces.push(await request<Workspace>("workspace_create", { name: path.basename(dir), path: dir }));
      }
      await request("active_workspace_set", { id: workspaces[0]!.id });
      await page.reload();
    } else {
      workspaces.push(...(await request<Workspace[]>("workspace_list")));
    }
    await ready(page);

    const claudeLaunches = async () => {
      const log = await readFile(path.join(home, "fake-claude.log"), "utf8").catch(() => "");
      return log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ClaudeLaunch);
    };

    return {
      app,
      window: page,
      root,
      home,
      userData,
      workspaces,
      request,
      reload,
      git,
      makeRepo,
      addWorkspace,
      claudeLaunches,
      restart,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The window is up once the rail and the panel beside it have painted. */
async function ready(page: Page): Promise<void> {
  await page.locator('nav[aria-label="Workspaces"][data-sidebar-rail]').waitFor({ state: "visible" });
  await page.locator("[data-sidebar-panel]").waitFor({ state: "visible" });
}

/**
 * The machine's environment with the user taken out: HOME and the XDG folders
 * point into the sandbox, and PATH holds the sandbox's bins and the system's,
 * never the user's own (~/.local/bin there holds real provider CLIs).
 */
function sandboxEnv(home: string, config: string): NodeJS.ProcessEnv {
  const system = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    PATH: [path.join(home, ".local/bin"), path.join(home, "bin"), ...system].join(":"),
    SHELL: "/bin/bash",
    // Only the sandbox's .gitconfig: nothing from the machine's /etc/gitconfig.
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function prepareSandbox(home: string, config: string, repos: string): Promise<void> {
  const bin = path.join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(home, "bin"), { recursive: true });
  await mkdir(config, { recursive: true });
  await mkdir(repos, { recursive: true });
  const gitconfig = path.join(home, ".gitconfig");
  if (!existsSync(gitconfig)) {
    await writeFile(
      gitconfig,
      "[user]\n\tname = Crew E2E\n\temail = e2e@crew.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n",
    );
  }
  // `node` for fake CLIs and scripts run in the sandbox: this one, since PATH
  // leaves out wherever the machine keeps its own.
  const node = path.join(home, "bin/node");
  if (!existsSync(node)) await symlink(process.execPath, node);
  // The default browser: Electron's shell.openExternal runs `xdg-open <url>`
  // off PATH on Linux. The fake keeps each call's argument, one per line.
  const opener = path.join(home, "bin/xdg-open");
  if (!existsSync(opener)) {
    await writeFile(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${path.join(home, "xdg-open.log")}"\n`);
    await chmod(opener, 0o755);
  }
  // The fake runs on this Node too, named outright.
  const claude = path.join(bin, "claude");
  const source = await readFile(FAKE_CLAUDE, "utf8");
  await writeFile(claude, source.replace(/^#!.*\n/, `#!${process.execPath}\n`));
  await chmod(claude, 0o755);
}

/** `afterExit` runs once the app's process is gone, before Playwright lets go of it. */
async function quit(app: ElectronApplication, afterExit: () => Promise<void>): Promise<void> {
  const proc = app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) {
    await afterExit();
    return;
  }
  const exited = new Promise<boolean>((resolve) => proc.once("exit", () => resolve(true)));
  // app.quit() runs before-quit, which stops crewd first. The evaluate may not
  // come back: the process can be gone before it answers.
  void app.evaluate(({ app }) => app.quit()).catch(() => {});
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000).unref());
  if (await Promise.race([exited, timeout])) {
    await afterExit();
    await app.close().catch(() => {});
    return;
  }
  console.error("e2e: the app did not quit within 15s; killing it");
  proc.kill("SIGKILL");
  await exited;
  await afterExit();
  // crewd exits on its own once its stdin, the dead app's pipe, closes.
}

/**
 * Fake CLIs still running once the app is gone. None should be: crewd ends
 * its terminals. One that outlived it (the terminal it holds never hung up)
 * would keep the sandbox and the app's inherited pipes open, so the harness
 * ends it and says so.
 */
async function killStragglers(home: string): Promise<void> {
  const log = await readFile(path.join(home, "fake-claude.log"), "utf8").catch(() => "");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let left = log
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as ClaudeLaunch).pid)
    .filter(alive);
  // The hangup crewd's exit sends takes a moment to land.
  for (let waited = 0; left.length > 0 && waited < 2000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = left.filter(alive);
  }
  for (const pid of left) {
    console.error(`e2e: fake claude ${pid} outlived the app; killing it`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

type Rpc = { request: Crew["request"]; close(): void };
type Connection = Rpc & { url: string; open(): boolean };

/**
 * The harness's RPC, which follows crewd across a restart: once the socket
 * closes, the next call asks the main process for the daemon it runs now and
 * connects there. The main process keeps the dead daemon's info until the new
 * one handshakes, so a url that did not change is waited out.
 */
async function rpcFor(page: Page, info: DaemonInfo): Promise<Rpc> {
  let current: Promise<Connection> = connect(info);
  let stopped = false;
  const reconnect = async (dead: string): Promise<Connection> => {
    const until = Date.now() + 30_000;
    let last: unknown = null;
    while (Date.now() < until) {
      try {
        const next = await page.evaluate(() => window.crewHost!.daemonInfo());
        if (next.url !== dead) return await connect(next);
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`crewd did not come back within 30s${last instanceof Error ? `: ${last.message}` : ""}`);
  };
  const request = async <T>(method: string, params: object = {}): Promise<T> => {
    if (stopped) throw new Error("the harness closed its crewd connection");
    const held = current;
    let connection = await held;
    if (!connection.open()) {
      // Calls that find the socket closed together share one reconnect.
      if (current === held) {
        const dead = connection;
        current = reconnect(dead.url);
        // A failed attempt is not kept: the next call tries again.
        current.catch(() => {
          current = Promise.resolve(dead);
        });
      }
      connection = await current;
    }
    return connection.request<T>(method, params);
  };
  return {
    request,
    close: () => {
      stopped = true;
      void current.then((connection) => connection.close()).catch(() => {});
    },
  };
}

// Same framing as the renderer's transport: authenticate, then JSON requests
// matched to responses by id. Events and binary terminal frames are ignored.
async function connect(info: DaemonInfo): Promise<Connection> {
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

  return { request, close: () => ws.close(), url: info.url, open: () => ws.readyState === WebSocket.OPEN };
}

/** The pid of the crewd the app runs now, found by the data directory it was given. */
export async function crewdPid(crew: Crew): Promise<number> {
  const { stdout } = await run("pgrep", ["-f", `crewd --data-dir ${crew.userData}$`]).catch(() => ({ stdout: "" }));
  const pids = stdout.split("\n").filter(Boolean).map(Number);
  if (pids.length !== 1) throw new Error(`expected one crewd for ${crew.userData}, found ${JSON.stringify(pids)}`);
  return pids[0]!;
}

/** The sessions of a workspace, as crewd stores them. */
export function sessions(crew: Crew, workspaceId: string): Promise<Session[]> {
  return crew.request<Session[]>("session_list", { workspaceId });
}

/**
 * The user comes back to the window from another app, which is when the app
 * re-reads what may have changed outside it (git worktrees, among others).
 * Xvfb has no window manager to move focus between windows, so neither
 * BrowserWindow.blur/focus nor a click makes the page see it; the event the
 * app listens for is sent to the page instead.
 */
export async function returnToWindow(crew: Crew): Promise<void> {
  await crew.window.evaluate(() => {
    window.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new FocusEvent("focus"));
  });
}

type Truthy<T> = Exclude<T, null | undefined | false | 0 | "">;

/** Polls until `fn` returns something truthy, retrying through throws. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  { timeout = 10_000, interval = 50, message }: { timeout?: number; interval?: number; message?: string } = {},
): Promise<Truthy<T>> {
  const until = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as Truthy<T>;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= until) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`${message ?? "waitFor"}: gave up after ${timeout}ms; last: ${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** A worktree's line in the sidebar panel, by the label it shows (its branch). */
export function worktreeHeader(crew: Crew, label: string): Locator {
  return crew.window
    .locator("[data-sidebar-panel] button[data-nav][aria-expanded]")
    .filter({ has: crew.window.getByText(label, { exact: true }) });
}

/** The worktree line the window is on. */
export function currentWorktree(crew: Crew): Locator {
  return crew.window.locator('[data-sidebar-panel] button[data-nav][aria-expanded][aria-current="true"]');
}

export type GitWorktree = { path: string; branch: string | null };

/** `git worktree list --porcelain`, one { path, branch } per worktree; branch is the full ref. */
export async function gitWorktrees(crew: Crew, repo: string): Promise<GitWorktree[]> {
  const porcelain = await crew.git(repo, "worktree", "list", "--porcelain");
  return porcelain.split("\n\n").map((block) => {
    const lines = block.split("\n");
    const at = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "";
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
    return { path: at, branch };
  });
}

/** Every local branch of `repo`, sorted. */
export async function gitBranches(crew: Crew, repo: string): Promise<string[]> {
  const out = await crew.git(repo, "for-each-ref", "--format=%(refname)", "refs/heads");
  return out.split("\n").filter(Boolean).sort();
}

/** The tab ids of the strip on screen, in order. */
export function stripTabIds(crew: Crew): Promise<string[]> {
  return crew.window
    .locator('[data-tab-strip] [role="tab"][data-tab-id]')
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-id") ?? ""));
}

/** A strip as crewd keeps it (`tabs:<context>`), or null when none was saved. `recent` is newest first. */
export async function savedStrip(
  crew: Crew,
  context: string,
): Promise<{ ids: string[]; activeId: string | null; recent: string[] } | null> {
  const raw = await crew.request<string | null>("state_get", { key: `tabs:${context}` });
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { tabs: { id: string }[]; activeId: string | null; recent?: string[] };
  return { ids: parsed.tabs.map((tab) => tab.id), activeId: parsed.activeId, recent: parsed.recent ?? [] };
}

/** The texts the kit paints as errors (a field's, a dialog's failure) inside `scope`. */
export async function errorsIn(scope: Locator): Promise<string[]> {
  const texts = await scope.locator(".text-kumo-danger").allInnerTexts();
  return texts.map((text) => text.trim()).filter(Boolean);
}

/**
 * An app chord (⌘N, ⌥⌘N, ⌘,…). Off macOS the command key is Ctrl, and a
 * focused terminal takes Ctrl chords as control characters (terminalKeys.ts
 * hands every one of them to xterm), so there the chord is pressed with the
 * terminal let go, as a user would click out of it first.
 */
export async function pressChord(crew: Crew, chord: string): Promise<void> {
  if (process.platform !== "darwin") {
    await crew.window.evaluate(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(".xterm")) focused.blur();
    });
  }
  await crew.window.keyboard.press(chord);
}

/** ⌥⌘N, the branch typed over the dialog's "feat/", ↵: the dialog closes once the worktree exists. */
export async function newWorktree(crew: Crew, branch: string): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+Alt+n`);
  const input = page.getByRole("textbox", { name: "Branch" });
  await input.waitFor();
  await input.fill(branch);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

/** ⌘N: a terminal session where the window is, once crewd has it and its CLI reads keys. */
export async function newTerminal(crew: Crew, workspaceId: string): Promise<Session> {
  const known = new Set((await sessions(crew, workspaceId)).map((session) => session.id));
  await pressChord(crew, `${MOD}+n`);
  const session = await waitFor(
    async () => (await sessions(crew, workspaceId)).find((row) => row.kind === "terminal" && !known.has(row.id)),
    { message: "the new session reaches crewd" },
  );
  await waitFor(() => existsSync(path.join(crew.userData, "claude-bind", `${session.id}.json`)), {
    message: "the session's CLI starts",
  });
  return session;
}

/** A session's row in the sidebar panel, by the name it shows. */
export function sessionRow(crew: Crew, name: string): Locator {
  return crew.window
    .locator("[data-sidebar-panel] button[data-session]")
    .filter({ has: crew.window.getByText(name, { exact: true }) });
}

/** A session's pill in the tab strip on screen. */
export function sessionTab(crew: Crew, session: Session): Locator {
  return crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id*="${session.id}"]`);
}

/**
 * What the status light inside `scope` says: "Working", "Unread", "Needs
 * input", "Error", or "Idle" when it draws none (a read, resting session).
 */
export async function lightIn(scope: Locator): Promise<string> {
  // One read of the DOM: a count and then a getAttribute would race the light
  // going out (Working → Idle removes it), and getAttribute then waits 30s for
  // an element that is gone, which outlasts any waitFor sampling this.
  const labels = await scope
    .locator('[role="img"][aria-label]')
    .evaluateAll((lights) => lights.map((light) => light.getAttribute("aria-label") ?? ""));
  return labels[0] || "Idle";
}

/** A session's status as crewd stores it, or null once it is gone. */
export async function storedStatus(crew: Crew, id: string): Promise<Session["status"] | null> {
  const row = await crew.request<Session | null>("session_get", { id });
  return row?.status ?? null;
}

/** Types a line into the terminal on screen and submits it. */
export async function typeInTerminal(crew: Crew, line: string): Promise<void> {
  await waitFor(
    () =>
      crew.window.evaluate(() => {
        const shown = [...document.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")].find(
          (area) => area.closest("[hidden]") === null && area.getClientRects().length > 0,
        );
        shown?.focus();
        return shown !== undefined && document.activeElement === shown;
      }),
    { message: "a terminal on screen takes the keys" },
  );
  await crew.window.keyboard.type(line);
  await crew.window.keyboard.press("Enter");
}

/**
 * Samples `check` for `ms` and throws on the first sample that fails: for what
 * must stay true for a while, not merely become true.
 */
export async function holdsFor(
  ms: number,
  check: () => Promise<boolean | string> | boolean | string,
  message: string,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const verdict = await check();
    if (verdict !== true) {
      throw new Error(`${message}${typeof verdict === "string" ? `: ${verdict}` : ""} (after ${ms - (until - Date.now())}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** What went to the default browser (the fake `xdg-open`), oldest first. */
export async function externalOpens(crew: Crew): Promise<string[]> {
  const log = await readFile(path.join(crew.home, "xdg-open.log"), "utf8").catch(() => "");
  return log.split("\n").filter(Boolean);
}

export type PageServer = {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  origin: string;
  /** Paths requested so far (GETs of pages, not favicons), oldest first. */
  requests: string[];
  close(): Promise<void>;
};

/**
 * A local web server, the only web the sandbox has: each path answers a page
 * titled by `titles[path]` (or the path itself), and every request is kept.
 */
export async function servePages(titles: Record<string, string> = {}): Promise<PageServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    requests.push(at);
    const title = titles[at] ?? at;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
