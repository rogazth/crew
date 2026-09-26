// The packaged app's crewd: a LaunchAgent that outlives the window, which the
// app installs, connects to and, when it has to, starts through launchctl.
// Quitting the app only lets go of it. The decisions are daemon-agent-plan.ts;
// this is the disk, launchctl and the socket.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import {
  classify,
  installNeeded,
  launchctlTarget,
  mismatchNotice,
  nextStep,
  parseDaemonFile,
  parsePlistJson,
  plistPath,
  sameDaemon,
  watchStep,
  type DaemonFile,
  type Found,
} from "./daemon-agent-plan";

type DaemonInfo = { url: string; token: string };

type Options = {
  crewd: string;
  crew: string;
  dataDir: string;
  version: string;
  uid: number;
  // A daemon other than the one the app connected to took over.
  onNewDaemon: () => void;
  // Another version took over while the app was open; said once per version.
  onMismatch: (message: string) => void;
};

export type AgentLink = {
  // Read on every connect by the window and the browser host: a restarted
  // daemon has a new port and token.
  info(): DaemonInfo | null;
  // Stop watching; crewd keeps running. For a plain quit.
  release(): void;
  // "Quit Crew and Stop Everything": crewd stops its processes and exits 0,
  // which launchd takes as "leave it down".
  shutdown(): Promise<void>;
};

// Everything outside this file it touches, so a test can stand in for
// launchctl and crewd.
export type System = {
  run(file: string, args: string[], timeout?: number): Promise<string>;
  bridgeCall(file: DaemonFile, method: string): Promise<boolean>;
  alive(pid: number | undefined): boolean | null;
  realpath(p: string): string;
  ms: {
    poll: number;
    // launchd starts crewd in well under a second; a daemon that has to stop
    // the one it replaces first (5 s stop grace for its processes) takes longer.
    start: number;
    // crewd's stop grace plus the PTY host's second, with room.
    exit: number;
    watch: number;
    // launchd throttles a crash loop to one start per 10 s; the watchdog does
    // not undo that by kickstarting on every tick.
    startEvery: number;
  };
};

const PROBE_TIMEOUT_MS = 2000;

function run(file: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(file)} ${args.join(" ")}: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One line out, one line back, as `crew` speaks to the bridge.
export function bridgeCall(file: DaemonFile, method: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(file.socket);
    let reply = "";
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: file.userToken, method, params: null })}\n`));
    socket.on("data", (chunk: string) => {
      reply += chunk;
      const end = reply.indexOf("\n");
      if (end < 0) return;
      try {
        done("result" in (JSON.parse(reply.slice(0, end)) as object));
      } catch {
        done(false);
      }
    });
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
  });
}

function alive(pid: number | undefined): boolean | null {
  if (pid === undefined) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A path that does not exist (yet) is compared as spelled.
function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export const system: System = {
  run,
  bridgeCall,
  alive,
  realpath,
  ms: { poll: 200, start: 20_000, exit: 10_000, watch: 2000, startEvery: 10_000 },
};

export async function connectAgent(options: Options, sys: System = system): Promise<AgentLink> {
  const { crewd, crew, dataDir, version, uid, onNewDaemon, onMismatch } = options;
  const { ms } = sys;
  const target = launchctlTarget(uid);
  const plist = plistPath(dataDir);
  const daemonJson = path.join(dataDir, "daemon.json");
  const log = path.join(dataDir, "crewd.log");
  let current: DaemonFile | null = null;
  let watching: ReturnType<typeof setTimeout> | undefined;
  // The tick in flight, which a shutdown waits out.
  let tick: Promise<void> | null = null;
  // Set by a quit, plain or stopping everything, and checked after every
  // await on the watchdog's way to launchctl: a tick that was already
  // looking when the quit came must not start crewd again behind it.
  let stopping = false;
  let strikes = 0;
  let lastStart = 0;
  let warned: string | null = null;

  const readDaemonFile = async () => parseDaemonFile(await readFile(daemonJson, "utf8").catch(() => ""));

  const look = async (): Promise<Found> => {
    const file = await readDaemonFile();
    if (!file) return classify(null, { alive: null, answers: false }, version);
    const isAlive = sys.alive(file.pid);
    const answers = isAlive === false ? false : await sys.bridgeCall(file, "whoami");
    return classify(file, { alive: isAlive, answers }, version);
  };

  // The app moved, was replaced by another copy, or never installed it.
  // `--as-user`: the app is the user, even when it was started from inside a
  // Crew terminal and inherited a session's environment.
  const ensureInstalled = async () => {
    const installed = parsePlistJson(await sys.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]).catch(() => ""));
    if (!installNeeded(installed, { program: crewd, dataDir }, sys.realpath)) return;
    await sys.run(crew, ["daemon", "install", "--crewd", crewd, "--data-dir", dataDir, "--as-user", "--json"], 60_000);
  };

  // Loaded if it is not (it never is after a reboot), then kickstarted:
  // nothing counts on RunAtLoad. `kill` stops a running one first; one that
  // was only just loaded is left alone.
  const start = async (kill: boolean) => {
    lastStart = Date.now();
    const loaded = await sys.run("/bin/launchctl", ["print", target.service]).then(
      () => true,
      () => false,
    );
    if (stopping) return;
    if (!loaded) await sys.run("/bin/launchctl", ["bootstrap", target.domain, plist]);
    if (stopping) return;
    await sys.run("/bin/launchctl", kill && loaded ? ["kickstart", "-k", target.service] : ["kickstart", target.service]);
  };

  const exited = async (file: DaemonFile) => {
    const deadline = Date.now() + ms.exit;
    while (Date.now() < deadline) {
      if (sys.alive(file.pid) === false) return true;
      if (file.pid === undefined && !(await readDaemonFile())) return true;
      await sleep(ms.poll);
    }
    return false;
  };

  // Asked, so it stops its processes the usual way; one too old to know
  // `daemon/shutdown`, or stuck, is stopped by `kickstart -k` instead. Only
  // ever on launch (see nextStep).
  const replace = async (file: DaemonFile) => {
    if ((await sys.bridgeCall(file, "daemon/shutdown")) && (await exited(file))) await start(false);
    else await start(true);
  };

  // A daemon other than `old` that answers, of whichever version.
  const fresh = async (old: DaemonFile | null): Promise<Found | null> => {
    const deadline = Date.now() + ms.start;
    while (Date.now() < deadline) {
      const found = await look();
      if ((found.kind === "ready" || found.kind === "mismatch") && !sameDaemon(found.file, old)) return found;
      await sleep(ms.poll);
    }
    return null;
  };

  const launch = async (): Promise<DaemonFile> => {
    await ensureInstalled();
    let found = await look();
    // Twice: an update can meet an old daemon, and one replace settles it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const step = nextStep(found);
      if (step.do === "connect") return step.file;
      if (step.do === "replace") await replace(step.file);
      else await start(step.do === "restart");
      const old = "file" in found ? found.file : null;
      const next = await fresh(old);
      if (!next) throw new Error(`crewd did not come up within ${ms.start / 1000} s.\nLog: ${log}`);
      found = next;
    }
    if (found.kind === "ready") return found.file;
    const running = "file" in found ? found.file.version : "?";
    throw new Error(`crewd ${running} is running, but this Crew is ${version}.\nLog: ${log}`);
  };

  // While the app is open it wants a daemon: one that crashed is back as soon
  // as launchd or this brings it back, and one `crew daemon stop` stopped is
  // started again, as the dev app does with its child.
  const check = async () => {
    const found = await look();
    if (stopping) return;
    const step = watchStep(found, current, strikes, warned);
    strikes = step.do === "wait" ? strikes + 1 : 0;
    switch (step.do) {
      case "keep":
      case "wait":
      case "leave":
        return;
      case "switch":
        current = step.file;
        onNewDaemon();
        return;
      case "warn":
        warned = step.file.version;
        onMismatch(mismatchNotice(step.file.version, version));
        return;
      case "start":
      case "restart":
        if (Date.now() - lastStart >= ms.startEvery) await start(step.do === "restart");
    }
  };

  const watch = async () => {
    watching = undefined;
    if (stopping) return;
    const running = check().catch((error: unknown) => console.error("crewd watch:", error));
    tick = running;
    await running;
    tick = null;
    if (!stopping) watching = setTimeout(() => void watch(), ms.watch);
  };

  current = await launch();
  watching = setTimeout(() => void watch(), ms.watch);

  const release = () => {
    stopping = true;
    if (watching) clearTimeout(watching);
  };

  return {
    info: () => (current ? { url: current.url, token: current.token } : null),
    release,
    shutdown: async () => {
      release();
      // A tick past its last check may still be in launchctl; stopping
      // before it returns would race whatever it started.
      await tick;
      const file = (await readDaemonFile()) ?? current;
      if (file && (await sys.bridgeCall(file, "daemon/shutdown")) && (await exited(file))) return;
      // Not answering: bootout stops it (SIGTERM, then SIGKILL) and unloads
      // it; the next launch bootstraps it again.
      await sys.run("/bin/launchctl", ["bootout", target.service]).catch((error: unknown) => console.error(error));
    },
  };
}

// Before this run falls back to crewd as its child: a LaunchAgent that came
// up late, or half way, would be a second daemon on the same database. Booted
// out, it is also not restarted by KeepAlive; the next launch loads it again.
export async function unloadAgent(uid: number): Promise<void> {
  await run("/bin/launchctl", ["bootout", launchctlTarget(uid).service], 20_000).catch(() => {});
}
