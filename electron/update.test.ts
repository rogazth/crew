import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../src/test/deferred";

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn<(name: string) => string>(),
    getVersion: vi.fn<() => string>(),
    quit: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn<(options: MessageBox) => Promise<{ response: number; checkboxChecked: boolean }>>() },
  spawn: vi.fn<(command: string, args: string[], options: object) => FakeChild>(),
  tmp: { root: "" },
}));

vi.mock("electron", () => ({ app: mocks.app, dialog: mocks.dialog }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: () => {
    if (!mocks.tmp.root) throw new Error("this test has no temp dir");
    return mocks.tmp.root;
  },
}));

type MessageBox = {
  type?: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
};

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  unref = vi.fn();
}

const RELEASES = "https://github.com/rogazth/crew/releases";
const MANIFEST = `${RELEASES}/latest/download/latest.json`;
const ZIP = `${RELEASES}/download/v0.2.0/Crew-0.2.0-mac-arm64.zip`;
const BUNDLE = "/Applications/Crew.app";
const EXE = `${BUNDLE}/Contents/MacOS/Crew`;
const bytes = new TextEncoder().encode("PK\u0003\u0004 a zip in name only");
const SHA = createHash("sha256").update(bytes).digest("hex");
const HOUR = 60 * 60 * 1000;

const release = (version = "0.2.0") => ({ version, zip: ZIP, sha256: SHA });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let routes: Map<string, () => Response | Promise<Response>>;
let children: Array<{ command: string; args: string[]; options: object; child: FakeChild }>;
let ditto: (child: FakeChild, args: string[]) => Promise<void>;

function reply(status: number, body: () => Promise<unknown>): Response {
  return { ok: status >= 200 && status < 300, status, json: body } as Response;
}

function serve(manifest: unknown, zip: () => Response = () => new Response(bytes)): void {
  routes.set(MANIFEST, () => reply(200, async () => manifest));
  routes.set(ZIP, zip);
}

async function unpack(child: FakeChild, args: string[]): Promise<void> {
  const contents = path.join(args.at(-1) ?? "", "Crew.app", "Contents");
  await mkdir(contents, { recursive: true });
  await writeFile(path.join(contents, "Info.plist"), "<plist/>");
  child.emit("exit", 0);
}

function shown(): MessageBox[] {
  return mocks.dialog.showMessageBox.mock.calls.map(([options]) => options);
}

function answer(response: number): void {
  mocks.dialog.showMessageBox.mockResolvedValue({ response, checkboxChecked: false });
}

async function load() {
  vi.resetModules();
  return import("./update");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.app.isPackaged = true;
  mocks.app.getPath.mockImplementation((name) => (name === "exe" ? EXE : ""));
  mocks.app.getVersion.mockReturnValue("0.1.4");
  answer(1);
  routes = new Map();
  children = [];
  ditto = unpack;
  mocks.spawn.mockImplementation((command, args, options) => {
    const child = new FakeChild();
    children.push({ command, args, options, child });
    if (command === "/usr/bin/ditto") void Promise.resolve().then(() => ditto(child, args));
    return child;
  });
  fetchMock.mockImplementation(async (url) => {
    const route = routes.get(url);
    if (!route) throw new Error(`nothing served at ${url}`);
    return route();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("checkForUpdates outside the installed app", () => {
  it("tells a manual check from a checkout that updates apply to the installed app", async () => {
    mocks.app.isPackaged = false;
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown()).toEqual([
      {
        type: "info",
        message: "Updates apply to the installed app",
        detail: "This window runs from the checkout, so there is nothing to replace.",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a packaged app that is not inside a .app bundle the same way", async () => {
    mocks.app.getPath.mockImplementation((name) => (name === "exe" ? "/opt/Crew/crew" : ""));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().map((box) => box.message)).toEqual(["Updates apply to the installed app"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an automatic check from a checkout silent", async () => {
    mocks.app.isPackaged = false;
    const { checkForUpdates } = await load();
    await checkForUpdates();
    expect(shown()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkForUpdates", () => {
  it("asks the release host for the manifest, bypassing caches", async () => {
    serve(release("0.1.4"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST, { headers: { "cache-control": "no-cache" } });
  });

  it("confirms a manual check when the installed version is the latest", async () => {
    serve(release("0.1.4"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown()).toEqual([{ type: "info", message: "Crew 0.1.4 is the latest version" }]);
  });

  it("keeps an automatic check with nothing new silent", async () => {
    serve(release("0.1.4"));
    const { checkForUpdates } = await load();
    await checkForUpdates();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([]);
  });

  it("offers a newer version, with Later as the cancel button", async () => {
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates();
    expect(shown()).toEqual([
      {
        type: "info",
        message: "Crew 0.2.0 is available",
        detail: "You are on 0.1.4. Crew will replace itself and reopen.",
        buttons: ["Update and Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      },
    ]);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it.each([
    ["0.1.5", "0.1.4", true],
    ["0.2.0", "0.1.9", true],
    ["1.0.0", "0.9.9", true],
    ["0.10.0", "0.9.0", true],
    ["0.1.4", "0.1.4", false],
    ["0.1.3", "0.1.4", false],
    ["0.9.9", "1.0.0", false],
    ["0.2", "0.1.4", false],
    ["0.2.0.1", "0.1.4", false],
    ["v0.2.0", "0.1.4", false],
    ["0.2.0-beta.1", "0.1.4", false],
    ["0.2.x", "0.1.4", false],
    ["1.-2.0", "0.1.4", false],
    ["0.2.5", "dev", false],
    ["0.2.5", "0.1", false],
  ])("treats %s against an installed %s as newer: %s", async (latest, current, offered) => {
    mocks.app.getVersion.mockReturnValue(current);
    serve(release(latest));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().map((box) => box.message)).toEqual([
      offered ? `Crew ${latest} is available` : `Crew ${current} is the latest version`,
    ]);
  });

  it.each([
    ["null", null],
    ["a string", "0.2.0"],
    ["an array", []],
    ["a numeric version", { ...release(), version: 2 }],
    ["a missing version", { zip: ZIP, sha256: SHA }],
    ["a numeric zip", { ...release(), zip: 42 }],
    ["a missing sha256", { version: "0.2.0", zip: ZIP }],
    ["an uppercase sha256", { ...release(), sha256: SHA.toUpperCase() }],
    ["a short sha256", { ...release(), sha256: SHA.slice(1) }],
    ["a long sha256", { ...release(), sha256: `${SHA}0` }],
    ["a zip on another host", { ...release(), zip: "https://evil.example/Crew-0.2.0-mac-arm64.zip" }],
    ["a zip over plain http", { ...release(), zip: ZIP.replace("https:", "http:") }],
    ["a zip from another repository", { ...release(), zip: ZIP.replace("rogazth/crew", "someone/crew") }],
    ["a zip behind the latest redirect", { ...release(), zip: `${RELEASES}/latest/download/Crew.zip` }],
  ])("refuses a manifest with %s", async (_name, manifest) => {
    serve(manifest);
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown()).toEqual([
      { type: "error", message: "Could not update Crew", detail: "latest.json is not a manifest Crew can use" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reports a release host that does not answer OK", async () => {
    routes.set(MANIFEST, () => reply(503, async () => ({})));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown()).toEqual([
      { type: "error", message: "Could not update Crew", detail: `${MANIFEST} answered 503` },
    ]);
  });

  it("reports a manifest that is not JSON", async () => {
    routes.set(MANIFEST, () => new Response("<html>rate limited</html>"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toMatchObject({ type: "error", message: "Could not update Crew" });
  });

  it("reports a failure that is not an Error as text", async () => {
    fetchMock.mockRejectedValueOnce("offline");
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown()).toEqual([{ type: "error", message: "Could not update Crew", detail: "offline" }]);
  });

  it("logs a failed automatic check instead of showing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    routes.set(MANIFEST, () => reply(500, async () => ({})));
    const { checkForUpdates } = await load();
    await checkForUpdates();
    expect(shown()).toEqual([]);
    expect(error).toHaveBeenCalledWith(`update check failed: ${MANIFEST} answered 500`);
  });

  it("stops offering a version to automatic checks once it was put off", async () => {
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates();
    await checkForUpdates();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(shown().map((box) => box.message)).toEqual(["Crew 0.2.0 is available"]);
  });

  it("still offers a put-off version to a manual check", async () => {
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates();
    await checkForUpdates(true);
    expect(shown().map((box) => box.message)).toEqual(["Crew 0.2.0 is available", "Crew 0.2.0 is available"]);
  });

  it("offers a release newer than the one put off", async () => {
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates();
    serve(release("0.3.0"));
    await checkForUpdates();
    expect(shown().map((box) => box.message)).toEqual(["Crew 0.2.0 is available", "Crew 0.3.0 is available"]);
  });

  it("ignores a check that starts while another is still running", async () => {
    const manifest = deferred<Response>();
    routes.set(MANIFEST, () => manifest.promise);
    const { checkForUpdates } = await load();
    const first = checkForUpdates(true);
    await checkForUpdates(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([]);
    manifest.resolve(reply(200, async () => release("0.1.4")));
    await first;
    expect(shown().map((box) => box.message)).toEqual(["Crew 0.1.4 is the latest version"]);
    await checkForUpdates(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a new check after one failed", async () => {
    fetchMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND github.com"));
    serve(release("0.1.4"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    await checkForUpdates(true);
    expect(shown().map((box) => box.detail ?? box.message)).toEqual([
      "getaddrinfo ENOTFOUND github.com",
      "Crew 0.1.4 is the latest version",
    ]);
  });
});

describe("installing an update", () => {
  beforeEach(async () => {
    const os = await vi.importActual<typeof import("node:os")>("node:os");
    mocks.tmp.root = await mkdtemp(path.join(os.tmpdir(), "crew-update-test-"));
    answer(0);
  });

  afterEach(async () => {
    await rm(mocks.tmp.root, { recursive: true, force: true });
    mocks.tmp.root = "";
  });

  it("verifies the download, unpacks it and hands the swap to a detached shell before quitting", async () => {
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([MANIFEST, ZIP]);
    expect(shown().map((box) => box.message)).toEqual(["Crew 0.2.0 is available"]);
    expect(children.map(({ command }) => command)).toEqual(["/usr/bin/ditto", "/bin/sh"]);

    const [unzip, swap] = children;
    const [flagX, flagK, zip, unpacked] = unzip?.args ?? [];
    const stage = path.dirname(zip ?? "");
    expect([flagX, flagK]).toEqual(["-x", "-k"]);
    expect(path.dirname(stage)).toBe(mocks.tmp.root);
    expect(path.basename(stage)).toMatch(/^crew-update-/);
    expect(zip).toBe(path.join(stage, "Crew-0.2.0-mac-arm64.zip"));
    expect(unpacked).toBe(path.join(stage, "unpacked"));
    expect(new Uint8Array(await readFile(zip ?? ""))).toEqual(bytes);

    const script = path.join(stage, "swap.sh");
    expect(swap?.args).toEqual([script, String(process.pid), BUNDLE, path.join(stage, "unpacked", "Crew.app"), stage]);
    expect(swap?.options).toEqual({ detached: true, stdio: "ignore" });
    expect(swap?.child.unref).toHaveBeenCalledTimes(1);
    expect(await readFile(script, "utf8")).toMatch(/^#!\/bin\/sh\n/);
    expect((await stat(script)).mode & 0o100).toBe(0o100);

    expect(mocks.app.quit).toHaveBeenCalledTimes(1);
    const spawnedAt = mocks.spawn.mock.invocationCallOrder[1] ?? Infinity;
    expect(spawnedAt).toBeLessThan(mocks.app.quit.mock.invocationCallOrder[0] ?? 0);
  });

  it("refuses a download whose sha256 does not match the manifest", async () => {
    const other = createHash("sha256").update("something else").digest("hex");
    serve({ ...release("0.2.0"), sha256: other });
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().at(-1)).toEqual({
      type: "error",
      message: "Could not update Crew",
      detail: `checksum mismatch: the manifest says ${other}, the download is ${SHA}`,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it("refuses a zip the host does not serve", async () => {
    serve(release("0.2.0"), () => new Response("gone", { status: 404 }));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().at(-1)?.detail).toBe(`${ZIP} answered 404`);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("refuses a zip response without a body", async () => {
    serve(release("0.2.0"), () => new Response(null));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().at(-1)?.detail).toBe(`${ZIP} answered without a body`);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("stops with ditto's stderr when it cannot unpack the zip", async () => {
    ditto = async (child) => {
      child.stderr.emit("data", Buffer.from("ditto: Couldn't read PKZip signature\n"));
      child.emit("exit", 1);
    };
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().at(-1)?.detail).toBe("/usr/bin/ditto exited 1: ditto: Couldn't read PKZip signature");
    expect(children.map(({ command }) => command)).toEqual(["/usr/bin/ditto"]);
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it("stops when ditto is killed by a signal", async () => {
    ditto = async (child) => {
      child.emit("exit", null);
    };
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().at(-1)?.detail).toBe("/usr/bin/ditto exited ?: ");
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it("stops when ditto cannot start", async () => {
    ditto = async (child) => {
      child.emit("error", new Error("spawn /usr/bin/ditto ENOENT"));
    };
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().at(-1)?.detail).toBe("spawn /usr/bin/ditto ENOENT");
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it("stops when the zip does not hold a Crew.app", async () => {
    ditto = async (child) => {
      child.emit("exit", 0);
    };
    serve(release("0.2.0"));
    const { checkForUpdates } = await load();
    await checkForUpdates(true);
    expect(shown().at(-1)).toMatchObject({ type: "error", detail: expect.stringContaining("Info.plist") });
    expect(children.map(({ command }) => command)).toEqual(["/usr/bin/ditto"]);
    const stage = path.dirname(children[0]?.args[2] ?? "");
    await expect(access(path.join(stage, "swap.sh"))).rejects.toThrow();
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });
});

describe("watchForUpdates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    serve(release("0.1.4"));
  });

  it("schedules nothing in a checkout", async () => {
    mocks.app.isPackaged = false;
    const { watchForUpdates } = await load();
    watchForUpdates();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7 * HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks 15 seconds after launch, then every 6 hours", async () => {
    const { watchForUpdates } = await load();
    watchForUpdates();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR - 15_001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(shown()).toEqual([]);
  });

  it("keeps its timers from holding the process open", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const { watchForUpdates } = await load();
    watchForUpdates();
    const timers = [...timeout.mock.results, ...interval.mock.results].map(
      (result) => result.value as { hasRef(): boolean },
    );
    expect(timers).toHaveLength(2);
    expect(timers.map((timer) => timer.hasRef())).toEqual([false, false]);
  });
});
