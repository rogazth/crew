import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
import { buildMenu } from "./menu";

type DaemonInfo = { url: string; token: string };
type OpenOptions = { multiple?: boolean; directory?: boolean };

let win: BrowserWindow | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let info: DaemonInfo | null = null;
let stopping = false;
let restarts = 0;

function crewdPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "crewd");
  return path.join(app.getAppPath(), "target/debug/crewd");
}

function csp(): string {
  const connect = app.isPackaged
    ? "ws://127.0.0.1:*"
    : "http://localhost:1420 ws://localhost:1420 ws://127.0.0.1:*";
  return [
    "default-src 'self'",
    "script-src 'self'",
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

function readInfo(proc: ChildProcessWithoutNullStreams): Promise<DaemonInfo> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: proc.stdout });
    const fail = (error: Error) => {
      lines.close();
      reject(error);
    };
    lines.once("line", (line) => {
      lines.close();
      try {
        const parsed = JSON.parse(line) as DaemonInfo;
        if (typeof parsed.url !== "string" || typeof parsed.token !== "string") {
          throw new Error("crewd handshake was not {url, token}");
        }
        resolve(parsed);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    proc.once("error", (error) => fail(error));
    proc.once("exit", (code) => fail(new Error(`crewd exited ${code ?? ""}`.trim())));
  });
}

async function startDaemon(): Promise<void> {
  const proc = spawn(crewdPath(), ["--data-dir", app.getPath("userData")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child = proc;
  info = await readInfo(proc);
  proc.once("exit", () => {
    if (child === proc) child = null;
    if (stopping) return;
    if (restarts === 0) {
      restarts += 1;
      void startDaemon()
        .then(() => win?.reload())
        .catch((error) => {
          dialog.showErrorBox("Crew", String(error));
          app.quit();
        });
      return;
    }
    dialog.showErrorBox("Crew", "The Crew daemon stopped unexpectedly.");
    app.quit();
  });
}

function stopDaemon(): Promise<void> {
  const proc = child;
  if (!proc) return Promise.resolve();
  stopping = true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 2000);
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
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (app.isPackaged) {
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
    const options = {
      properties: opts.directory
        ? (["openDirectory"] as const)
        : opts.multiple
          ? (["openFile", "multiSelections"] as const)
          : (["openFile"] as const),
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
}

app.setName("Crew");

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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (stopping || !child) return;
  event.preventDefault();
  void stopDaemon().then(() => app.quit());
});
