// How the packaged app finds the crewd its LaunchAgent runs, worked out
// without touching the disk or launchd so it can be tested. daemon-agent.ts
// does the touching.

import path from "node:path";

// package.json's build.appId plus ".crewd". crates/crew-cli/src/launch_agent.rs
// writes the plist under the same label; a test on each side holds it to
// package.json.
export const AGENT_LABEL = "rogazth.crew.crewd";

// In the data dir, not ~/Library/LaunchAgents: launchd would load it at every
// login, and KeepAlive { SuccessfulExit } starts a job as soon as it is loaded
// (launchd.plist(5)). Here crewd runs only once Crew starts it.
export function plistPath(dataDir: string): string {
  return path.join(dataDir, `${AGENT_LABEL}.plist`);
}

export function launchctlTarget(uid: number): { domain: string; service: string } {
  const domain = `gui/${uid}`;
  return { domain, service: `${domain}/${AGENT_LABEL}` };
}

// <data-dir>/daemon.json, as crewd writes it (crew_protocol::DaemonFile).
export type DaemonFile = {
  url: string;
  token: string;
  socket: string;
  userToken: string;
  version: string;
  pid?: number;
};

export function parseDaemonFile(text: string): DaemonFile | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const field = (key: string) => (typeof parsed[key] === "string" && parsed[key] !== "" ? (parsed[key] as string) : null);
    const [url, token, socket, userToken, version] = ["url", "token", "socket", "userToken", "version"].map(field);
    if (!url || !token || !socket || !userToken || !version) return null;
    const file: DaemonFile = { url, token, socket, userToken, version };
    if (typeof parsed.pid === "number") file.pid = parsed.pid;
    return file;
  } catch {
    return null;
  }
}

// What the installed plist runs, read from `plutil -convert json`.
export type Installed = { program: string; dataDir: string | null };

export function parsePlistJson(text: string): Installed | null {
  try {
    const args = (JSON.parse(text) as { ProgramArguments?: unknown }).ProgramArguments;
    if (!Array.isArray(args) || typeof args[0] !== "string") return null;
    const at = args.indexOf("--data-dir");
    const dataDir = at >= 0 && typeof args[at + 1] === "string" ? (args[at + 1] as string) : null;
    return { program: args[0], dataDir };
  } catch {
    return null;
  }
}

// No plist, or one for another crewd (the app was moved, or a copy elsewhere
// installed its own) or another data dir: `crew daemon install` writes ours,
// which also stops whatever the old one ran.
export function installNeeded(installed: Installed | null, want: { program: string; dataDir: string }): boolean {
  if (!installed || installed.dataDir === null) return true;
  return path.resolve(installed.program) !== path.resolve(want.program) || path.resolve(installed.dataDir) !== path.resolve(want.dataDir);
}

// What is behind daemon.json right now.
export type Found =
  | { kind: "missing" }
  // Its pid is gone: it crashed, or was killed, before it could remove the file.
  | { kind: "stale"; file: DaemonFile }
  // Alive, or its pid unknown, but not answering: hung, or on its way out.
  | { kind: "unreachable"; file: DaemonFile }
  // Answering, but another version: the app was updated under it.
  | { kind: "mismatch"; file: DaemonFile }
  | { kind: "ready"; file: DaemonFile };

export type Probe = { alive: boolean | null; answers: boolean };

export function classify(file: DaemonFile | null, probe: Probe, appVersion: string): Found {
  if (!file) return { kind: "missing" };
  if (probe.answers) return file.version === appVersion ? { kind: "ready", file } : { kind: "mismatch", file };
  if (probe.alive === false) return { kind: "stale", file };
  return { kind: "unreachable", file };
}

export type Step =
  | { do: "connect"; file: DaemonFile }
  // Loaded if it is not (after a reboot it never is), then kickstarted; a
  // stale file goes first so nothing reads a dead address.
  | { do: "start"; stale: DaemonFile | null }
  // `kickstart -k`: SIGTERM to the one that does not answer, then a new one.
  | { do: "restart" }
  // Asked to exit (`daemon/shutdown`, so it stops its processes the usual
  // way and the auto-start ones come back), then started.
  | { do: "replace"; file: DaemonFile };

// On launch.
export function nextStep(found: Found): Step {
  switch (found.kind) {
    case "ready":
      return { do: "connect", file: found.file };
    case "missing":
      return { do: "start", stale: null };
    case "stale":
      return { do: "start", stale: found.file };
    case "unreachable":
      return { do: "restart" };
    case "mismatch":
      return { do: "replace", file: found.file };
  }
}

export function sameDaemon(a: DaemonFile, b: DaemonFile | null): boolean {
  return b !== null && a.url === b.url && a.pid === b.pid;
}

// How many checks in a row a daemon that is alive may fail before it is
// taken for hung. crewd removes daemon.json before it stops its processes, so
// one on its way out reads as missing, not as this.
export const HUNG_STRIKES = 3;

export type WatchStep = Step | { do: "keep" } | { do: "switch"; file: DaemonFile } | { do: "wait" };

// While the app runs: `current` is the daemon it is connected to, `strikes`
// how many checks in a row found it not answering.
export function watchStep(found: Found, current: DaemonFile | null, strikes: number): WatchStep {
  switch (found.kind) {
    case "ready":
      return sameDaemon(found.file, current) ? { do: "keep" } : { do: "switch", file: found.file };
    case "unreachable":
      return strikes + 1 >= HUNG_STRIKES ? { do: "restart" } : { do: "wait" };
    default:
      return nextStep(found);
  }
}

// How a packaged launch ends. The LaunchAgent is tried first; if it cannot be
// installed, loaded or reached, this run falls back to the dev way, crewd as
// the app's child, so Crew still opens, and only its processes stop with it.
export type Outcome = { ok: true } | { ok: false; error: string };

export type Launch =
  | { run: "agent" }
  | { run: "try-child" }
  | { run: "child"; notice: string; why: string }
  | { run: "none"; dialog: string };

export const CHILD_NOTICE =
  "Crew couldn't start its background service, so this time processes and agents stop when Crew quits.";

export function decideLaunch(agent: Outcome, child?: Outcome): Launch {
  if (agent.ok) return { run: "agent" };
  if (!child) return { run: "try-child" };
  if (child.ok) return { run: "child", notice: CHILD_NOTICE, why: agent.error };
  return { run: "none", dialog: `Could not start crewd.\n\nAs a LaunchAgent: ${agent.error}\n\nAs Crew's child: ${child.error}` };
}
