import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  session,
  type OpenDialogOptions,
} from "electron";
import {
  installBrowser,
  registerBrowserIpc,
  registerFileIpc,
  registerFileScheme,
  serveFiles,
  startBrowserHost,
} from "./browser";
import { openExternal } from "./external";
import { release, sha } from "./build-info";
import { connectAgent, launchdStandIn, unloadAgent, type AgentLink } from "./daemon-agent";
import { decideLaunch, translocated, TRANSLOCATED_NOTICE, type Outcome } from "./daemon-agent-plan";
import { registerCliIpc } from "./install-cli";
import { buildMenu } from "./menu";
import { registerRemoteIpc } from "./remotes";
import { parseColorMode, type ColorMode } from "../src/lib/colorMode";
import { watchForUpdates } from "./update";

type DaemonInfo = { url: string; token: string };
type OpenOptions = { multiple?: boolean; directory?: boolean };
// stderr is inherited, so the handle has no stream for it.
type Daemon = ChildProcessByStdio<Writable, Readable, null>;

let win: BrowserWindow | null = null;
// Dev (worktrees included) runs crewd as this process's child, on its own
// data dir, and stops it on quit. The packaged app connects to the
// LaunchAgent instead, and quitting leaves it running.
let agent: AgentLink | null = null;
let child: Daemon | null = null;
let info: DaemonInfo | null = null;
let stopping = false;
let restarts = 0;
let starting: Promise<void> | null = null;
// A daemon that ran this long before it died was stopped (`crew daemon
// restart`, a kill), not crash-looping, so it is started again even after
// the one restart a crash gets.
const STEADY_MS = 60_000;
let upSince = 0;

function crewdPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "crewd");
  return path.join(app.getAppPath(), "target/debug/crewd");
}

function daemonInfo(): DaemonInfo | null {
  return agent ? agent.info() : info;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attempt(run: () => Promise<void>): Promise<Outcome> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

// Resolves to a notice for the user when this run could not use the
// LaunchAgent; throws only when there is no daemon at all.
async function connectDaemon(): Promise<string | null> {
  // CREW_E2E_AGENT: e2e takes the packaged app's way to crewd, a LaunchAgent,
  // with a stand-in for launchd.
  if (e2e && process.env.CREW_E2E_AGENT === "1") {
    const dataDir = app.getPath("userData");
    agent = await connectAgent(
      { crewd: crewdPath(), crew: "crew", dataDir, version: app.getVersion(), uid: 0, onNewDaemon: () => win?.reload(), onMismatch: () => {} },
      launchdStandIn(crewdPath(), dataDir),
    );
    return null;
  }
  if (!app.isPackaged) {
    await startDaemon().catch((error: unknown) => Promise.reject(new Error(`Could not start crewd: ${reason(error)}`)));
    return null;
  }
  const uid = process.getuid?.() ?? 0;
  const viaAgent: Outcome = translocated(process.resourcesPath)
    ? { ok: false, error: `Crew runs from App Translocation (${process.resourcesPath})`, notice: TRANSLOCATED_NOTICE }
    : await attempt(async () => {
        agent = await connectAgent({
          crewd: crewdPath(),
          crew: path.join(process.resourcesPath, "crew"),
          dataDir: app.getPath("userData"),
          version: app.getVersion(),
          uid,
          // A crash launchd recovered from, or `crew daemon restart`: its PTYs are
          // gone, so the window starts over, as it does when dev restarts its child.
          onNewDaemon: () => win?.reload(),
          onMismatch: (message) => {
            if (Notification.isSupported()) new Notification({ title: "Crew", body: message }).show();
          },
        });
      });
  let launch = decideLaunch(viaAgent);
  if (launch.run === "try-child") {
    if (!viaAgent.ok) console.error(`crewd LaunchAgent unavailable; running crewd as Crew's child: ${viaAgent.error}`);
    await unloadAgent(uid, app.getPath("userData"));
    launch = decideLaunch(viaAgent, await attempt(startDaemon));
  }
  switch (launch.run) {
    case "agent":
    case "try-child":
      return null;
    case "child":
      return launch.notice;
    case "none":
      throw new Error(launch.dialog);
  }
}

// "Quit Crew and Stop Everything". In dev a plain quit already does this.
async function quitAndStopEverything(): Promise<void> {
  for (const window of BrowserWindow.getAllWindows()) window.hide();
  await agent?.shutdown();
  app.quit();
}

// e2e loads the built renderer, so it never depends on (or talks to) whatever
// dev server holds the dev port, and it runs under the packaged app's policy.
const fromDist = app.isPackaged || process.env.CREW_RENDERER === "dist";
// CREW_E2E hides the window. On macOS the app is an accessory: it stays out of
// the Dock and does not activate when the window is created. `prohibited`
// cannot create windows. Without the variable the dev app shows as usual.
const e2e = process.env.CREW_E2E === "1";

// Two checkouts can run side by side: each takes its own dev port (CREW_PORT);
// scripts/app.mjs picks a free one for a git worktree.
const DEV_PORT = Number(process.env.CREW_PORT) || 1420;

function csp(): string {
  // `ws:` and not a host list: a remote crewd is any tailnet address, added
  // while the window is open, and a document's policy is fixed when it loads.
  const connect = fromDist ? "ws:" : `http://localhost:${DEV_PORT} ws:`;
  return [
    "default-src 'self'",
    fromDist ? "script-src 'self'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // crew-file: is an image file tab's picture, served from the worktree it was opened from.
    // Google's favicon service answers from www.google.com by redirecting to a gstatic host.
    "img-src 'self' data: blob: crew-file: https://www.google.com https://*.gstatic.com",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
  ].join("; ");
}

function allowedUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}`;

function allowedNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!fromDist) return parsed.origin === DEV_ORIGIN;
    if (parsed.protocol !== "file:") return false;
    const root = pathToFileURL(path.join(app.getAppPath(), "dist")).href;
    return parsed.href === root || parsed.href.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

function parseInfo(line: string): DaemonInfo | null {
  try {
    const parsed = JSON.parse(line) as DaemonInfo;
    if (typeof parsed.url === "string" && typeof parsed.token === "string") return parsed;
  } catch {
    return null;
  }
  return null;
}

function ignoreStdout(proc: Daemon): void {
  proc.stdout.removeAllListeners();
  proc.stdout.resume();
}

function readInfo(proc: Daemon): Promise<DaemonInfo> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: proc.stdout });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      lines.close();
      reject(error);
    };
    lines.on("line", (line) => {
      const parsed = parseInfo(line);
      if (!parsed || settled) return;
      settled = true;
      lines.close();
      ignoreStdout(proc);
      resolve(parsed);
    });
    proc.once("error", (error) => fail(error));
  });
}

function recover(error: unknown): Promise<void> {
  if (stopping) return Promise.resolve();
  if (restarts === 0 || (upSince > 0 && Date.now() - upSince > STEADY_MS)) {
    restarts = 1;
    return startDaemon().then(() => {
      win?.reload();
    });
  }
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

async function startDaemon(): Promise<void> {
  const run = (async () => {
    const dir = app.getPath("userData");
    upSince = 0;
    const proc = spawn(crewdPath(), ["--data-dir", dir], {
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    });
    child = proc;
    const exited = new Promise<Error>((resolve) => {
      proc.once("exit", (code) => {
        if (child === proc) child = null;
        resolve(new Error(`crewd exited ${code ?? ""}`.trim()));
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Error>((resolve) => {
      timer = setTimeout(() => {
        resolve(new Error(`crewd did not handshake within 10s.\nData directory: ${dir}`));
      }, 10_000);
    });
    const failed = Promise.race([exited, timedOut]).then((error) => Promise.reject(error));
    void failed.catch(() => {});
    try {
      info = await Promise.race([readInfo(proc), failed]);
      upSince = Date.now();
    } catch (error) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
      await recover(error);
      return;
    } finally {
      if (timer) clearTimeout(timer);
    }
    void exited.then((error) => {
      if (stopping) return;
      void recover(error).catch((retryError) => {
        dialog.showErrorBox("Crew", String(retryError));
        app.quit();
      });
    });
  })();
  starting = run;
  try {
    await run;
  } finally {
    if (starting === run) starting = null;
  }
}

async function stopDaemon(): Promise<void> {
  stopping = true;
  if (starting) await starting.catch(() => {});
  const proc = child;
  if (!proc) return;
  return new Promise((resolve) => {
    // crewd gives supervised processes one stop grace (5 s) and the PTY host
    // one more second before it exits.
    const timer = setTimeout(() => {
      console.error("crewd still running after SIGTERM; continuing quit");
      resolve();
    }, 8000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

// Kept by main, not crewd, so the window opens in the mode before the renderer loads.
const colorModeFile = () => path.join(app.getPath("userData"), "color-mode");

function readColorMode(): ColorMode {
  try {
    return parseColorMode(readFileSync(colorModeFile(), "utf8").trim());
  } catch {
    return parseColorMode(null);
  }
}

/** The canvas colour in each mode, so the window never flashes the other one. */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#0f0f0f" : "#ffffff");

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 520,
    // A 0×0 window, or one moved off screen, changes layout or still activates
    // the app. Hidden keeps 1280×800. A native open dialog has nothing to
    // attach to while this stays hidden: dialog-open shows the window for
    // that call. The dialog is not stubbed.
    show: !e2e,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Pages are <webview>s so the app's own overlays can sit on top of them.
      // Each one is vetted and hardened in installBrowser before it attaches.
      webviewTag: true,
    },
  });
  installBrowser(win);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => {
    if (!allowedNavigation(event.url)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event) => {
    if (!allowedNavigation(event.url)) event.preventDefault();
  });
  if (fromDist) {
    void win.loadFile(path.join(app.getAppPath(), "dist/index.html"));
  } else {
    void win.loadURL(DEV_ORIGIN);
  }
  win.on("closed", () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("daemon-info", () => {
    const current = daemonInfo();
    if (!current) throw new Error("Crew daemon is not running");
    return current;
  });
  ipcMain.handle("dialog-open", async (event, opts: OpenOptions = {}) => {
    const target = BrowserWindow.fromWebContents(event.sender) ?? win ?? undefined;
    // The real dialog. A hidden window cannot parent it, so that run shows.
    if (target && !target.isVisible()) target.show();
    const options: OpenDialogOptions = {
      properties: opts.directory
        ? ["openDirectory"]
        : opts.multiple
          ? ["openFile", "multiSelections"]
          : ["openFile"],
    };
    const { canceled, filePaths } = target
      ? await dialog.showOpenDialog(target, options)
      : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return null;
    if (opts.multiple && !opts.directory) return filePaths;
    return filePaths[0] ?? null;
  });
  ipcMain.handle("home-dir", () => homedir());
  // The window's own zoom, for the chrome and chats; terminals and pages zoom themselves.
  ipcMain.handle("app-zoom", (event, delta: number) => {
    const contents = event.sender;
    const level = delta === 0 ? 0 : Math.min(3, Math.max(-3, contents.getZoomLevel() + delta * 0.5));
    contents.setZoomLevel(level);
  });
  ipcMain.handle("color-mode-get", () => nativeTheme.themeSource);
  ipcMain.handle("color-mode-set", (_event, raw: string) => {
    const mode = parseColorMode(raw);
    nativeTheme.themeSource = mode;
    writeFileSync(colorModeFile(), mode);
  });
  ipcMain.handle("open-url", async (_event, url: string) => {
    if (!allowedUrl(url)) return;
    await openExternal(url);
  });
  ipcMain.handle("notify", (_event, payload: { title: string; body: string }) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: payload.title, body: payload.body }).show();
  });
  registerBrowserIpc();
  registerFileIpc();
  registerRemoteIpc(daemonInfo);
  registerCliIpc();
}

registerFileScheme();
// Only the published release runs on the installed app's userData, where crewd
// keeps its database and socket: any other build there would drive the installed
// app's sessions. A dev build takes "Crew Dev"; a package built here (npm run
// app:build, a bare electron-builder) is "Crew Local", which the name also gives
// a keychain key of its own.
// CREW_USER_DATA points either at a data set of its own, like the seeded one;
// scripts/app.mjs points a git worktree at a folder inside it, so removing the
// worktree removes its database. The release ignores it: started from a dev
// terminal, it would open that checkout's data.
const local = app.isPackaged && !release;
app.setName(local ? "Crew Local" : "Crew");
if (!(app.isPackaged && release))
  app.setPath(
    "userData",
    process.env.CREW_USER_DATA || path.join(app.getPath("appData"), local ? "Crew Local" : "Crew Dev"),
  );
// One window per userData, so dev, local and release builds each run once. A
// second launch on the same data would start a second crewd there; it only
// brings the first one forward. crewd refuses a folder in use as well.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion(), version: sha });
if (e2e && process.platform === "darwin") app.setActivationPolicy("accessory");
// The sandboxed HOME has no login keychain; remote tokens go through a mock one.
if (e2e) app.commandLine.appendSwitch("use-mock-keychain");

// A second Crew on this data dir hands over to the first: it would run a
// second watchdog over the same crewd, or a second child daemon.
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (daemonInfo()) {
    createWindow();
  }
});

app.whenReady().then(async () => {
  if (!primary) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp()],
      },
    });
  });
  serveFiles(session.defaultSession);
  nativeTheme.themeSource = readColorMode();
  nativeTheme.on("updated", () => win?.setBackgroundColor(windowBackground()));
  Menu.setApplicationMenu(buildMenu({ quitAndStopEverything: () => void quitAndStopEverything() }));
  registerIpc();
  let notice: string | null;
  try {
    notice = await connectDaemon();
  } catch (error) {
    dialog.showErrorBox("Crew", reason(error));
    app.quit();
    return;
  }
  createWindow();
  // Crew works as before; the user only needs to know quitting stops things.
  if (notice && Notification.isSupported()) new Notification({ title: "Crew", body: notice }).show();
  // Agents drive pages through main, over its own connection; it follows crewd across restarts.
  const browserHost = startBrowserHost(daemonInfo);
  app.once("will-quit", () => browserHost.stop());
  watchForUpdates(() => {
    if (!win) createWindow();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // Packaged: crewd and everything it runs stay up; the app only lets go.
  if (agent) {
    agent.release();
    return;
  }
  if (stopping || (!child && !starting)) return;
  event.preventDefault();
  void stopDaemon().then(() => app.quit());
});
