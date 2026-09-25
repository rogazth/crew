import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell, type OpenDialogOptions } from "electron";
import { installBrowser, registerBrowserIpc } from "./browser";
import { sha } from "./build-info";
import { buildMenu } from "./menu";
import { watchForUpdates } from "./update";

type DaemonInfo = { url: string; token: string };
type OpenOptions = { multiple?: boolean; directory?: boolean };
// stderr is inherited, so the handle has no stream for it.
type Daemon = ChildProcessByStdio<Writable, Readable, null>;

let win: BrowserWindow | null = null;
let child: Daemon | null = null;
let info: DaemonInfo | null = null;
let stopping = false;
let restarts = 0;
let starting: Promise<void> | null = null;

function crewdPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "crewd");
  return path.join(app.getAppPath(), "target/debug/crewd");
}

// e2e loads the built renderer, so it never depends on (or talks to) whatever
// dev server holds port 1420, and it runs under the packaged app's policy.
const fromDist = app.isPackaged || process.env.CREW_RENDERER === "dist";

function csp(): string {
  const connect = fromDist
    ? "ws://127.0.0.1:*"
    : "http://localhost:1420 ws://localhost:1420 ws://127.0.0.1:*";
  return [
    "default-src 'self'",
    fromDist ? "script-src 'self'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://www.google.com",
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

const DEV_ORIGIN = "http://127.0.0.1:1420";

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
  if (restarts === 0) {
    restarts += 1;
    return startDaemon().then(() => {
      win?.reload();
    });
  }
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

async function startDaemon(): Promise<void> {
  const run = (async () => {
    const dir = app.getPath("userData");
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
    const timer = setTimeout(() => {
      console.error("crewd still running after SIGTERM; continuing quit");
      resolve();
    }, 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 520,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: "#ffffff",
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
    void win.loadURL("http://127.0.0.1:1420");
  }
  win.on("closed", () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("daemon-info", () => {
    if (!info) throw new Error("Crew daemon is not running");
    return info;
  });
  ipcMain.handle("dialog-open", async (event, opts: OpenOptions = {}) => {
    const target = BrowserWindow.fromWebContents(event.sender) ?? win ?? undefined;
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
  ipcMain.handle("open-url", async (_event, url: string) => {
    if (!allowedUrl(url)) return;
    await shell.openExternal(url);
  });
  ipcMain.handle("notify", (_event, payload: { title: string; body: string }) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: payload.title, body: payload.body }).show();
  });
  registerBrowserIpc();
}

app.setName("Crew");
// userData follows the name, and crewd keeps its database and socket there: a dev
// build on the installed app's folder would drive the installed app's sessions.
if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Crew Dev"));
app.setAboutPanelOptions({ applicationName: "Crew", applicationVersion: app.getVersion(), version: sha });

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp()],
      },
    });
  });
  Menu.setApplicationMenu(buildMenu());
  registerIpc();
  try {
    await startDaemon();
  } catch (error) {
    dialog.showErrorBox("Crew", `Could not start crewd: ${error}`);
    app.quit();
    return;
  }
  createWindow();
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
  if (stopping || (!child && !starting)) return;
  event.preventDefault();
  void stopDaemon().then(() => app.quit());
});
