import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAgent, type AgentLink, type System } from "./daemon-agent";
import { parseDaemonFile, sameDaemon, type DaemonFile } from "./daemon-agent-plan";

const CREWD = "/Applications/Crew.app/Contents/Resources/crewd";

// Across fakes, so one never starts a crewd the last one's file already names.
let nextPid = 100;

// launchd and crewd as far as the app can see them: launchctl runs the
// plist's crewd, which writes daemon.json and answers on its socket until it
// is asked to stop.
function fakeLaunchd(dataDir: string) {
  const daemonJson = path.join(dataDir, "daemon.json");
  const calls: string[][] = [];
  const asked: string[] = [];
  let live: DaemonFile | null = null;
  let loaded = false;
  // What the crewd the plist names is.
  let version = "0.1.7";
  // While set, `launchctl print` waits for it.
  let held: Promise<void> | null = null;

  const spawn = () => {
    nextPid += 1;
    live = { url: `ws://127.0.0.1:${nextPid}`, token: "w", socket: "/d/crew.sock", userToken: "u", version, pid: nextPid };
    writeFileSync(daemonJson, JSON.stringify(live));
  };
  const stop = () => {
    if (live && sameDaemon(live, parseDaemonFile(existsSync(daemonJson) ? readFileSync(daemonJson, "utf8") : ""))) rmSync(daemonJson);
    live = null;
  };

  const sys: System = {
    async run(file, args) {
      const call = [path.basename(file), ...args];
      calls.push(call);
      if (call[0] === "plutil") return JSON.stringify({ ProgramArguments: [CREWD, "--data-dir", dataDir, "--supervised-by", "launchd"] });
      if (call[0] !== "launchctl") return "";
      switch (args[0]) {
        case "print":
          if (held) await held;
          if (!loaded) throw new Error("not loaded");
          return "state = running";
        case "bootstrap":
          loaded = true;
          return "";
        case "kickstart":
          if (args[1] === "-k") stop();
          if (!live) spawn();
          return "";
        case "bootout":
          loaded = false;
          stop();
          return "";
      }
      return "";
    },
    async bridgeCall(file, method) {
      if (!live || !sameDaemon(file, live)) return false;
      asked.push(method);
      if (method === "daemon/shutdown") stop();
      return true;
    },
    alive: (pid) => pid !== undefined && live?.pid === pid,
    realpath: (p) => p,
    ms: { poll: 5, start: 1000, exit: 500, watch: 10, startEvery: 0 },
  };

  return {
    sys,
    calls,
    asked,
    live: () => live,
    // KeepAlive bringing back whatever the plist names, as after a crash.
    crash(next = version) {
      stop();
      version = next;
      spawn();
    },
    // Gone, and nothing brought it back yet.
    die: stop,
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      return release;
    },
    launchctl: (verb: string) => calls.filter((call) => call[0] === "launchctl" && call[1] === verb).length,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("connectAgent", () => {
  let dataDir = "";
  let link: AgentLink | null = null;

  const connect = (launchd: ReturnType<typeof fakeLaunchd>, onMismatch = vi.fn()) =>
    connectAgent(
      { crewd: CREWD, crew: "/crew", dataDir, version: "0.1.7", uid: 501, onNewDaemon: () => {}, onMismatch },
      launchd.sys,
    );

  const fresh = () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "crew-agent-"));
    return fakeLaunchd(dataDir);
  };

  afterEach(() => {
    link?.release();
    link = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts crewd over a stale daemon.json and leaves the file to crewd", async () => {
    const launchd = fresh();
    writeFileSync(path.join(dataDir, "daemon.json"), JSON.stringify({ url: "ws://127.0.0.1:1", token: "w", socket: "/s", userToken: "u", version: "0.1.7", pid: 99_999 }));
    link = await connect(launchd);
    const live = launchd.live();
    expect(live).not.toBeNull();
    expect(link.info()).toEqual({ url: live?.url, token: "w" });
    expect(parseDaemonFile(readFileSync(path.join(dataDir, "daemon.json"), "utf8"))).toEqual(live);
    expect(launchd.calls.some((call) => call.includes("install"))).toBe(false);
  });

  // The watchdog used to replace it: `daemon/shutdown`, every process
  // stopped, and a kickstart that ran the very same other crewd, every tick.
  it("leaves another version alone while the window is open, and says so once", async () => {
    const launchd = fresh();
    const onMismatch = vi.fn();
    link = await connect(launchd, onMismatch);
    const kickstarts = launchd.launchctl("kickstart");
    launchd.crash("0.1.8");
    const other = launchd.live();
    await sleep(150);
    expect(launchd.live()).toBe(other);
    expect(launchd.asked).not.toContain("daemon/shutdown");
    expect(launchd.launchctl("kickstart")).toBe(kickstarts);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch.mock.calls[0]?.[0]).toContain("0.1.8");
  });

  it("starts a daemon that went away while the window is open", async () => {
    const launchd = fresh();
    link = await connect(launchd);
    const first = launchd.live();
    launchd.die();
    await vi.waitFor(() => expect(launchd.live()).not.toBeNull(), { timeout: 1000 });
    expect(launchd.live()).not.toBe(first);
  });

  // A tick already on its way to launchctl used to start crewd again behind
  // a quit, or behind "Quit Crew and Stop Everything".
  for (const quit of ["release", "shutdown"] as const) {
    it(`does not start crewd again once a quit began (${quit})`, async () => {
      const launchd = fresh();
      const current = await connect(launchd);
      link = current;
      const kickstarts = launchd.launchctl("kickstart");
      const release = launchd.hold();
      launchd.die();
      await vi.waitFor(() => expect(launchd.launchctl("print")).toBeGreaterThan(1), { timeout: 1000 });
      const quitting = quit === "release" ? Promise.resolve(current.release()) : current.shutdown();
      release();
      await quitting;
      await sleep(50);
      expect(launchd.launchctl("kickstart")).toBe(kickstarts);
      expect(launchd.launchctl("bootstrap")).toBe(1);
      expect(launchd.live()).toBeNull();
    });
  }

  it("reinstalls only when the plist really names another crewd", async () => {
    const launchd = fresh();
    launchd.sys.realpath = (p) => p.replace("/Volumes/Apps/", "/Applications/");
    link = await connectAgent(
      { crewd: "/Volumes/Apps/Crew.app/Contents/Resources/crewd", crew: "/crew", dataDir, version: "0.1.7", uid: 501, onNewDaemon: () => {}, onMismatch: () => {} },
      launchd.sys,
    );
    expect(launchd.calls.some((call) => call[0] === "crew")).toBe(false);

    link.release();
    const moved = fakeLaunchd(dataDir);
    link = await connectAgent(
      { crewd: "/Users/me/Crew.app/Contents/Resources/crewd", crew: "/crew", dataDir, version: "0.1.7", uid: 501, onNewDaemon: () => {}, onMismatch: () => {} },
      moved.sys,
    );
    const install = moved.calls.find((call) => call[0] === "crew");
    expect(install).toContain("--as-user");
  });
});
