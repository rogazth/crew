import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "../src/test/deferred";

type Handler = (event: { sender: object }, ...args: unknown[]) => unknown;
type NavigationEvent = { url: string; preventDefault(): void };
type Headers = Record<string, string[]>;
type HeadersListener = (
  details: { responseHeaders?: Headers },
  callback: (response: { responseHeaders: Headers }) => void,
) => void;
type WindowOptions = {
  webPreferences: { preload: string; contextIsolation: boolean; nodeIntegration: boolean; sandbox: boolean };
};

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const app = {
    isPackaged: false,
    ready: new Promise<void>(() => {}),
    on(name: string, listener: (...args: unknown[]) => unknown): void {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    once(name: string, listener: (...args: unknown[]) => unknown): void {
      const wrapped = (...args: unknown[]) => {
        listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== wrapped));
        return listener(...args);
      };
      app.on(name, wrapped);
    },
    emit(name: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
    },
    reset(): void {
      listeners.clear();
    },
    whenReady: vi.fn(() => app.ready),
    getAppPath: vi.fn(() => ""),
    getPath: vi.fn((_name: string) => ""),
    getVersion: vi.fn(() => "0.1.4"),
    setName: vi.fn(),
    setAboutPanelOptions: vi.fn(),
    quit: vi.fn(),
  };

  class BrowserWindow {
    static created: BrowserWindow[] = [];
    static fromWebContents = vi.fn((_contents: object): BrowserWindow | null => null);
    static getAllWindows = vi.fn((): BrowserWindow[] => []);
    options: unknown;
    events = new Map<string, (...args: unknown[]) => unknown>();
    contentsEvents = new Map<string, (...args: unknown[]) => unknown>();
    openHandler: (() => unknown) | undefined;
    loadFile = vi.fn(async (_file: string) => {});
    loadURL = vi.fn(async (_url: string) => {});
    reload = vi.fn();
    webContents = {
      setWindowOpenHandler: (handler: () => unknown) => {
        this.openHandler = handler;
      },
      on: (name: string, listener: (...args: unknown[]) => unknown) => {
        this.contentsEvents.set(name, listener);
      },
    };
    constructor(options: unknown) {
      this.options = options;
      BrowserWindow.created.push(this);
    }
    on(name: string, listener: (...args: unknown[]) => unknown): void {
      this.events.set(name, listener);
    }
  }

  class Notification {
    static isSupported = vi.fn(() => true);
    static shown: Array<{ title: string; body: string }> = [];
    options: { title: string; body: string };
    constructor(options: { title: string; body: string }) {
      this.options = options;
    }
    show(): void {
      Notification.shown.push(this.options);
    }
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const menu = { menu: "crew" };

  return {
    app,
    BrowserWindow,
    Notification,
    handlers,
    menu,
    ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(),
      showOpenDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: false, filePaths: [] as string[] })),
    },
    shell: { openExternal: vi.fn(async (_url: string) => {}) },
    Menu: { buildFromTemplate: vi.fn(() => menu), setApplicationMenu: vi.fn() },
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    spawn: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
  Menu: electron.Menu,
  Notification: electron.Notification,
  session: electron.session,
  shell: electron.shell,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: electron.spawn,
}));

type FakeWindow = InstanceType<typeof electron.BrowserWindow>;

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn((_signal?: string) => true);

  say(text: string): void {
    this.stdout.write(text);
  }

  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const APP_PATH = "/Users/me/crew";
const PACKAGED_APP_PATH = "/Applications/My Tools/Crew.app/Contents/Resources/app.asar";
const RESOURCES = "/Applications/My Tools/Crew.app/Contents/Resources";
const USER_DATA = "/Users/me/Library/Application Support/Crew";
const INFO = { url: "ws://127.0.0.1:52100", token: "secret" };
const RESTARTED = { url: "ws://127.0.0.1:52200", token: "fresh" };
const SENDER = { id: 1 };

const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://www.google.com; font-src 'self' data:; " +
  "connect-src http://localhost:1420 ws://localhost:1420 ws://127.0.0.1:*; " +
  "object-src 'none'; base-uri 'self'; frame-src 'none'";
const PACKAGED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://www.google.com; font-src 'self' data:; " +
  "connect-src ws://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-src 'none'";

let procs: FakeProcess[];
let ready: Deferred<void>;
const restore: Array<() => void> = [];

function override(key: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(process, key);
  Object.defineProperty(process, key, { value, configurable: true, writable: true });
  restore.push(() => {
    if (previous) Object.defineProperty(process, key, previous);
    else delete (process as unknown as Record<string, unknown>)[key];
  });
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for ${what}`);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function windows(): FakeWindow[] {
  return electron.BrowserWindow.created;
}

function proc(index: number): FakeProcess {
  const found = procs[index];
  if (!found) throw new Error(`crewd #${index + 1} was never spawned`);
  return found;
}

function handshake(target: FakeProcess, info: object = INFO): void {
  target.say(`${JSON.stringify(info)}\n`);
}

async function load(packaged = false): Promise<void> {
  electron.app.isPackaged = packaged;
  if (packaged) {
    override("resourcesPath", RESOURCES);
    electron.app.getAppPath.mockReturnValue(PACKAGED_APP_PATH);
  }
  await import("./main");
}

async function boot(packaged = false): Promise<FakeProcess> {
  await load(packaged);
  ready.resolve();
  await until(() => procs.length === 1, "crewd to spawn");
  return proc(0);
}

async function launch(packaged = false): Promise<FakeWindow> {
  handshake(await boot(packaged));
  await until(() => windows().length === 1, "the window");
  const [win] = windows();
  if (!win) throw new Error("no window");
  return win;
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = electron.handlers.get(channel) as Handler | undefined;
  if (!handler) throw new Error(`nothing handles ${channel}`);
  return handler({ sender: SENDER }, ...args);
}

function quitRequest(): { preventDefault: ReturnType<typeof vi.fn> } {
  const event = { preventDefault: vi.fn() };
  electron.app.emit("before-quit", event);
  return event;
}

function navigate(win: FakeWindow, kind: "will-navigate" | "will-redirect", url: string): boolean {
  const listener = win.contentsEvents.get(kind) as ((event: NavigationEvent) => void) | undefined;
  if (!listener) throw new Error(`no ${kind} listener`);
  let prevented = false;
  listener({
    url,
    preventDefault: () => {
      prevented = true;
    },
  });
  return !prevented;
}

function csp(details: { responseHeaders?: Headers }): { responseHeaders: Headers } {
  const listener = electron.session.defaultSession.webRequest.onHeadersReceived.mock.calls[0]?.[0] as
    | HeadersListener
    | undefined;
  if (!listener) throw new Error("no headers listener");
  let answer: { responseHeaders: Headers } | undefined;
  listener(details, (response) => {
    answer = response;
  });
  if (!answer) throw new Error("the headers listener did not answer");
  return answer;
}

function options(win: FakeWindow): WindowOptions {
  return win.options as WindowOptions;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  ready = deferred();
  procs = [];
  electron.app.reset();
  electron.app.ready = ready.promise;
  electron.app.getAppPath.mockReturnValue(APP_PATH);
  electron.app.getPath.mockImplementation((name) => (name === "userData" ? USER_DATA : ""));
  electron.handlers.clear();
  electron.BrowserWindow.created = [];
  electron.BrowserWindow.fromWebContents.mockReturnValue(null);
  electron.BrowserWindow.getAllWindows.mockImplementation(() => electron.BrowserWindow.created);
  electron.Notification.isSupported.mockReturnValue(true);
  electron.Notification.shown = [];
  electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
  electron.spawn.mockImplementation(() => {
    const spawned = new FakeProcess();
    procs.push(spawned);
    return spawned;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (restore.length) restore.pop()?.();
});

describe("startup", () => {
  it("names the app and fills the about panel with the version and commit", async () => {
    vi.stubGlobal("__CREW_SHA__", "fa723b8");
    await load();
    expect(electron.app.setName).toHaveBeenCalledWith("Crew");
    expect(electron.app.setAboutPanelOptions).toHaveBeenCalledWith({
      applicationName: "Crew",
      applicationVersion: "0.1.4",
      version: "fa723b8",
    });
  });

  it("waits for Electron to be ready before doing anything else", async () => {
    await load();
    await settle();
    expect(electron.app.whenReady).toHaveBeenCalledTimes(1);
    expect(electron.spawn).not.toHaveBeenCalled();
    expect(electron.handlers.size).toBe(0);
    expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled();
  });

  it("installs the menu and every IPC handler before crewd starts", async () => {
    await boot();
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledWith(electron.menu);
    expect([...electron.handlers.keys()].sort()).toEqual(["daemon-info", "dialog-open", "home-dir", "notify", "open-url"]);
    const lastHandler = Math.max(...electron.ipcMain.handle.mock.invocationCallOrder);
    expect(lastHandler).toBeLessThan(electron.spawn.mock.invocationCallOrder[0] ?? 0);
  });

  it("spawns the checkout's debug crewd on the user data dir", async () => {
    await boot();
    expect(electron.spawn).toHaveBeenCalledWith(path.join(APP_PATH, "target/debug/crewd"), ["--data-dir", USER_DATA], {
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    });
  });

  it("spawns the crewd bundled in the resources of a packaged app", async () => {
    await boot(true);
    expect(electron.spawn.mock.calls[0]?.[0]).toBe(path.join(RESOURCES, "crewd"));
  });

  it("opens the window only once crewd has handshaken", async () => {
    const crewd = await boot();
    await settle();
    expect(windows()).toHaveLength(0);
    handshake(crewd);
    await until(() => windows().length === 1, "the window");
  });

  it("starts watching for updates once a packaged app is up", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetch);
    electron.app.getPath.mockImplementation((name) =>
      name === "exe" ? "/Applications/Crew.app/Contents/MacOS/Crew" : name === "userData" ? USER_DATA : "",
    );
    await launch(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("update check failed: offline");
  });
});

describe("content security policy", () => {
  it("allows the dev server and inline scripts in a checkout", async () => {
    await boot();
    expect(csp({ responseHeaders: {} }).responseHeaders["Content-Security-Policy"]).toEqual([DEV_CSP]);
  });

  it("allows only the app's own scripts and the local daemon in a packaged app", async () => {
    await boot(true);
    expect(csp({ responseHeaders: {} }).responseHeaders["Content-Security-Policy"]).toEqual([PACKAGED_CSP]);
  });

  it("keeps the other response headers and overrides a policy the server sent", async () => {
    await boot();
    expect(
      csp({ responseHeaders: { "Content-Type": ["text/html"], "Content-Security-Policy": ["default-src *"] } }),
    ).toEqual({ responseHeaders: { "Content-Type": ["text/html"], "Content-Security-Policy": [DEV_CSP] } });
    expect(csp({})).toEqual({ responseHeaders: { "Content-Security-Policy": [DEV_CSP] } });
  });
});

describe("the crewd handshake", () => {
  it("hands the url and token from crewd's first line to the renderer", async () => {
    await launch();
    expect(invoke("daemon-info")).toEqual(INFO);
  });

  it("refuses daemon info before crewd has handshaken", async () => {
    await boot();
    expect(() => invoke("daemon-info")).toThrow("Crew daemon is not running");
  });

  it("skips lines that are not a handshake", async () => {
    const crewd = await boot();
    crewd.say("crewd 0.1.4 starting\n{not json\nnull\n42\n");
    crewd.say(`${JSON.stringify({ url: INFO.url })}\n`);
    crewd.say(`${JSON.stringify({ url: INFO.url, token: 7 })}\n`);
    crewd.say(`${JSON.stringify({ token: "secret" })}\n`);
    await settle();
    expect(windows()).toHaveLength(0);
    expect(() => invoke("daemon-info")).toThrow("Crew daemon is not running");
    handshake(crewd);
    await until(() => windows().length === 1, "the window");
    expect(invoke("daemon-info")).toEqual(INFO);
  });

  it("takes only a loopback websocket url as the handshake", async () => {
    const crewd = await boot();
    for (const url of [
      "http://127.0.0.1:52100",
      "wss://127.0.0.1:52100",
      "ws://example.com:52100",
      "ws://10.0.0.1:52100",
      "ws://127.0.0.1",
      "ws://127.0.0.1:0",
      "ws://127.0.0.1:70000",
      "ws://127.0.0.1:52100/elsewhere",
      "ws://user@127.0.0.1:52100",
    ]) {
      handshake(crewd, { url, token: "secret" });
    }
    await settle();
    expect(windows()).toHaveLength(0);
    expect(() => invoke("daemon-info")).toThrow("Crew daemon is not running");
    handshake(crewd, { url: "ws://localhost:52100", token: "secret" });
    await until(() => windows().length === 1, "the window");
    expect(invoke("daemon-info")).toEqual({ url: "ws://localhost:52100", token: "secret" });
  });

  it("treats a crewd that only prints foreign urls as one that never handshook", async () => {
    const first = await boot();
    handshake(first, { url: "http://127.0.0.1:52100", token: "secret" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    await until(() => procs.length === 2, "a second crewd");
    handshake(proc(1));
    await until(() => windows().length === 1, "the window");
    expect(invoke("daemon-info")).toEqual(INFO);
  });

  it("joins a handshake split across chunks", async () => {
    const crewd = await boot();
    const line = JSON.stringify(INFO);
    crewd.say(line.slice(0, 20));
    await settle();
    expect(windows()).toHaveLength(0);
    crewd.say(`${line.slice(20)}\n`);
    await until(() => windows().length === 1, "the window");
    expect(invoke("daemon-info")).toEqual(INFO);
  });

  it("reads a handshake that shares a chunk with earlier output", async () => {
    const crewd = await boot();
    crewd.say(`listening\n${JSON.stringify(INFO)}\n`);
    await until(() => windows().length === 1, "the window");
    expect(invoke("daemon-info")).toEqual(INFO);
  });

  it("takes the first handshake when crewd prints two at once", async () => {
    const crewd = await boot();
    crewd.say(`${JSON.stringify(INFO)}\n${JSON.stringify(RESTARTED)}\n`);
    await until(() => windows().length === 1, "the window");
    await settle();
    expect(invoke("daemon-info")).toEqual(INFO);
  });

  it("ignores a process error that arrives after the handshake", async () => {
    await launch();
    proc(0).emit("error", new Error("write EPIPE"));
    await settle();
    expect(procs).toHaveLength(1);
    expect(proc(0).kill).not.toHaveBeenCalled();
    expect(invoke("daemon-info")).toEqual(INFO);
  });

  it("ignores stdout after the handshake but keeps draining it", async () => {
    await launch();
    const crewd = proc(0);
    handshake(crewd, RESTARTED);
    crewd.say("x".repeat(1 << 20));
    await settle();
    expect(invoke("daemon-info")).toEqual(INFO);
    expect(crewd.stdout.readableLength).toBe(0);
    expect(crewd.stdout.readableFlowing).toBe(true);
  });
});

describe("crewd failing to start", () => {
  it("restarts crewd once when it exits before the handshake", async () => {
    const first = await boot();
    first.exit(1);
    await until(() => procs.length === 2, "a second crewd");
    handshake(proc(1), RESTARTED);
    await until(() => windows().length === 1, "the window");
    expect(first.kill).not.toHaveBeenCalled();
    expect(invoke("daemon-info")).toEqual(RESTARTED);
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("gives up, says why and quits when the restart also exits", async () => {
    (await boot()).exit(1);
    await until(() => procs.length === 2, "a second crewd");
    proc(1).exit(2);
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Crew", "Could not start crewd: Error: crewd exited 2");
    expect(electron.dialog.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
      electron.app.quit.mock.invocationCallOrder[0] ?? 0,
    );
    expect(windows()).toHaveLength(0);
    expect(procs).toHaveLength(2);
  });

  it("reports a crewd killed by a signal without an exit code", async () => {
    (await boot()).exit(null, "SIGKILL");
    await until(() => procs.length === 2, "a second crewd");
    proc(1).exit(null, "SIGKILL");
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Crew", "Could not start crewd: Error: crewd exited");
    expect(proc(0).kill).not.toHaveBeenCalled();
  });

  it("kills a crewd that has not handshaken within 10 s and tries again", async () => {
    const first = await boot();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(first.kill).not.toHaveBeenCalled();
    expect(procs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    await until(() => procs.length === 2, "a second crewd");
    handshake(proc(1));
    await until(() => windows().length === 1, "the window");
  });

  it("names the data dir when crewd never handshakes", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => procs.length === 2, "a second crewd");
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      "Crew",
      `Could not start crewd: Error: crewd did not handshake within 10s.\nData directory: ${USER_DATA}`,
    );
    expect(proc(1).kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("treats a spawn error as a failed start", async () => {
    const first = await boot();
    first.emit("error", new Error("spawn crewd ENOENT"));
    await until(() => procs.length === 2, "a second crewd");
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    proc(1).emit("error", new Error("spawn crewd ENOENT"));
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Crew", "Could not start crewd: Error: spawn crewd ENOENT");
  });

  it("reports a spawn failure that is not an Error as text", async () => {
    (await boot()).emit("error", "EACCES");
    await until(() => procs.length === 2, "a second crewd");
    proc(1).emit("error", "EACCES");
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Crew", "Could not start crewd: Error: EACCES");
  });

  it("stops a killed crewd that exits late from orphaning its replacement", async () => {
    const first = await boot();
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => procs.length === 2, "a second crewd");
    handshake(proc(1));
    await until(() => windows().length === 1, "the window");
    first.exit(null, "SIGTERM");
    await settle();
    expect(procs).toHaveLength(2);
    const event = quitRequest();
    expect(event.preventDefault).toHaveBeenCalled();
    await settle();
    expect(proc(1).kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("crewd exiting after the handshake", () => {
  it("restarts crewd and reloads the window onto the new daemon", async () => {
    const win = await launch();
    proc(0).exit(1);
    await until(() => procs.length === 2, "a second crewd");
    expect(win.reload).not.toHaveBeenCalled();
    handshake(proc(1), RESTARTED);
    await until(() => win.reload.mock.calls.length === 1, "the reload");
    expect(invoke("daemon-info")).toEqual(RESTARTED);
    expect(windows()).toHaveLength(1);
  });

  it("gives up after one restart, says why and quits", async () => {
    await launch();
    proc(0).exit(1);
    await until(() => procs.length === 2, "a second crewd");
    handshake(proc(1), RESTARTED);
    await settle();
    proc(1).exit(3);
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Crew", "Error: crewd exited 3");
    expect(procs).toHaveLength(2);
  });

  it("says why and quits when the restarted crewd dies before its handshake", async () => {
    await launch();
    proc(0).exit(1);
    await until(() => procs.length === 2, "a second crewd");
    proc(1).exit(4);
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith("Crew", "Error: crewd exited 4");
  });

  it("does not reload a window that was closed", async () => {
    const win = await launch();
    win.events.get("closed")?.();
    proc(0).exit(1);
    await until(() => procs.length === 2, "a second crewd");
    handshake(proc(1), RESTARTED);
    await settle();
    expect(win.reload).not.toHaveBeenCalled();
    expect(invoke("daemon-info")).toEqual(RESTARTED);
  });
});

describe("quitting", () => {
  it("holds the quit until crewd has exited, then quits", async () => {
    await launch();
    const event = quitRequest();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await settle();
    expect(proc(0).kill).toHaveBeenCalledWith("SIGTERM");
    expect(electron.app.quit).not.toHaveBeenCalled();
    proc(0).exit(null, "SIGTERM");
    await until(() => electron.app.quit.mock.calls.length === 1, "the quit");
    expect(procs).toHaveLength(1);
  });

  it("lets the quit through once crewd is being stopped", async () => {
    await launch();
    quitRequest();
    await settle();
    proc(0).exit(0);
    await until(() => electron.app.quit.mock.calls.length === 1, "the quit");
    expect(quitRequest().preventDefault).not.toHaveBeenCalled();
  });

  it("quits anyway when crewd ignores SIGTERM for 5 s", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await launch();
    quitRequest();
    await settle();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(electron.app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await until(() => electron.app.quit.mock.calls.length === 1, "the quit");
    expect(error).toHaveBeenCalledWith("crewd still running after SIGTERM; continuing quit");
  });

  it("lets the quit through before crewd was ever started", async () => {
    await load();
    expect(quitRequest().preventDefault).not.toHaveBeenCalled();
  });

  it("lets the quit through after crewd failed to start", async () => {
    (await boot()).exit(1);
    await until(() => procs.length === 2, "a second crewd");
    proc(1).exit(1);
    await until(() => electron.app.quit.mock.calls.length > 0, "the quit");
    expect(quitRequest().preventDefault).not.toHaveBeenCalled();
  });

  it("kills a starting crewd at once on quit and opens no window", async () => {
    const crewd = await boot();
    expect(quitRequest().preventDefault).toHaveBeenCalled();
    await settle();
    expect(crewd.kill).toHaveBeenCalledWith("SIGTERM");
    // A handshake that races the SIGTERM changes nothing.
    handshake(crewd);
    await settle();
    expect(electron.app.quit).not.toHaveBeenCalled();
    crewd.exit(null, "SIGTERM");
    await until(() => electron.app.quit.mock.calls.length === 1, "the quit");
    await settle();
    expect(windows()).toHaveLength(0);
    expect(procs).toHaveLength(1);
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("does not restart a crewd that dies while the app is quitting", async () => {
    const crewd = await boot();
    quitRequest();
    crewd.exit(1);
    await until(() => electron.app.quit.mock.calls.length === 1, "the quit");
    expect(procs).toHaveLength(1);
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("does not restart a running crewd that exits after the quit began", async () => {
    await launch();
    quitRequest();
    await settle();
    proc(0).exit(1);
    await until(() => electron.app.quit.mock.calls.length === 1, "the quit");
    await settle();
    expect(procs).toHaveLength(1);
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("quits when the last window closes, except on macOS", async () => {
    override("platform", "linux");
    await load();
    electron.app.emit("window-all-closed");
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
    override("platform", "darwin");
    electron.app.emit("window-all-closed");
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });
});

describe("the window", () => {
  it("is sandboxed and context isolated, without node integration", async () => {
    const win = await launch();
    const { webPreferences } = options(win);
    expect(webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(path.basename(webPreferences.preload)).toBe("preload.cjs");
  });

  it("denies every window.open", async () => {
    const win = await launch();
    expect(win.openHandler?.()).toEqual({ action: "deny" });
  });

  it("loads the dev server in a checkout", async () => {
    const win = await launch();
    expect(win.loadURL).toHaveBeenCalledWith("http://127.0.0.1:1420");
    expect(win.loadFile).not.toHaveBeenCalled();
  });

  it("loads the built index in a packaged app", async () => {
    const win = await launch(true);
    expect(win.loadFile).toHaveBeenCalledWith(path.join(PACKAGED_APP_PATH, "dist/index.html"));
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it.each([
    ["http://127.0.0.1:1420/", true],
    ["http://127.0.0.1:1420/#/session/7", true],
    ["http://localhost:1420/", false],
    ["http://127.0.0.1:1421/", false],
    ["https://127.0.0.1:1420/", false],
    ["https://example.com/", false],
    [pathToFileURL(path.join(APP_PATH, "dist/index.html")).href, false],
    ["not a url", false],
  ])("in a checkout, lets the window navigate to %s: %s", async (url, allowed) => {
    const win = await launch();
    expect(navigate(win, "will-navigate", url)).toBe(allowed);
    expect(navigate(win, "will-redirect", url)).toBe(allowed);
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    [pathToFileURL(path.join(PACKAGED_APP_PATH, "dist")).href, true],
    [pathToFileURL(path.join(PACKAGED_APP_PATH, "dist/index.html")).href, true],
    [`${pathToFileURL(path.join(PACKAGED_APP_PATH, "dist/index.html")).href}#/session/7`, true],
    [pathToFileURL(path.join(PACKAGED_APP_PATH, "dist-evil/index.html")).href, false],
    [pathToFileURL(path.join(PACKAGED_APP_PATH, "package.json")).href, false],
    ["file:///etc/passwd", false],
    ["http://127.0.0.1:1420/", false],
    ["https://example.com/", false],
    ["::", false],
  ])("in a packaged app, lets the window navigate to %s: %s", async (url, allowed) => {
    const win = await launch(true);
    expect(navigate(win, "will-navigate", url)).toBe(allowed);
    expect(navigate(win, "will-redirect", url)).toBe(allowed);
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it("reopens a window on activate only when none is open", async () => {
    await launch();
    electron.app.emit("activate");
    expect(windows()).toHaveLength(1);
    electron.BrowserWindow.getAllWindows.mockReturnValue([]);
    electron.app.emit("activate");
    expect(windows()).toHaveLength(2);
  });
});

describe("IPC", () => {
  it.each([
    [undefined, ["openFile"], ["/a.md", "/b.md"], "/a.md"],
    [{}, ["openFile"], ["/a.md"], "/a.md"],
    [{ multiple: true }, ["openFile", "multiSelections"], ["/a.md", "/b.md"], ["/a.md", "/b.md"]],
    [{ directory: true }, ["openDirectory"], ["/repo"], "/repo"],
    [{ directory: true, multiple: true }, ["openDirectory"], ["/repo", "/other"], "/repo"],
  ])("opens a dialog for %j with %j and answers the pick", async (opts, properties, filePaths, picked) => {
    const win = await launch();
    electron.BrowserWindow.fromWebContents.mockReturnValue(win);
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths });
    expect(await invoke("dialog-open", opts)).toEqual(picked);
    expect(electron.BrowserWindow.fromWebContents).toHaveBeenCalledWith(SENDER);
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(win, { properties });
  });

  it.each([
    [{ canceled: true, filePaths: ["/a.md"] }, {}],
    [{ canceled: false, filePaths: [] }, {}],
    [{ canceled: false, filePaths: [] }, { multiple: true }],
    [{ canceled: true, filePaths: [] }, { directory: true }],
  ])("answers null for %j", async (result, opts) => {
    await launch();
    electron.dialog.showOpenDialog.mockResolvedValue(result);
    expect(await invoke("dialog-open", opts)).toBeNull();
  });

  it("parents the dialog to the main window when the sender has none", async () => {
    const win = await launch();
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/a.md"] });
    await invoke("dialog-open", {});
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(win, { properties: ["openFile"] });
  });

  it("opens a free-standing dialog when no window is open", async () => {
    const win = await launch();
    win.events.get("closed")?.();
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/a.md"] });
    expect(await invoke("dialog-open", {})).toBe("/a.md");
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ["openFile"] });
  });

  it("answers the user's home directory", async () => {
    await boot();
    expect(invoke("home-dir")).toBe(homedir());
  });

  it.each(["https://example.com/docs", "http://127.0.0.1:3000/", "mailto:someone@example.com"])(
    "opens %s in the default handler",
    async (url) => {
      await boot();
      expect(await invoke("open-url", url)).toBeUndefined();
      expect(electron.shell.openExternal).toHaveBeenCalledWith(url);
    },
  );

  it.each(["file:///etc/passwd", "javascript:alert(1)", "vscode://file/etc/hosts", "crew://session/1", "not a url", ""])(
    "refuses to open %j",
    async (url) => {
      await boot();
      expect(await invoke("open-url", url)).toBeUndefined();
      expect(electron.shell.openExternal).not.toHaveBeenCalled();
    },
  );

  it("shows a notification with the title and body", async () => {
    await boot();
    invoke("notify", { title: "Crew", body: "Session finished" });
    expect(electron.Notification.shown).toEqual([{ title: "Crew", body: "Session finished" }]);
  });

  it("drops a notification where the OS does not support them", async () => {
    await boot();
    electron.Notification.isSupported.mockReturnValue(false);
    invoke("notify", { title: "Crew", body: "Session finished" });
    expect(electron.Notification.shown).toEqual([]);
  });
});
