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
// which also stops whatever the old one ran. Both sides go through `real`
// (realpath on disk): `crew daemon install` writes the crewd it resolved, so
// a bundle reached through a symlink would otherwise never match its own
// plist and be reinstalled, its processes stopped, on every launch.
export function installNeeded(
  installed: Installed | null,
  want: { program: string; dataDir: string },
  real: (p: string) => string = path.resolve,
): boolean {
  if (!installed || installed.dataDir === null) return true;
  return real(installed.program) !== real(want.program) || real(installed.dataDir) !== real(want.dataDir);
}

// Gatekeeper runs a quarantined app opened where it was downloaded from a
// random read-only path (App Translocation), a new one each launch. A
// LaunchAgent pointing in there would run a crewd that is gone by the next
// launch, so none is installed.
export function translocated(bundlePath: string): boolean {
  return /^(\/private)?\/var\/folders\/.+\/AppTranslocation\//.test(bundlePath);
}

export const TRANSLOCATED_NOTICE =
  "Crew is running from a temporary copy macOS made of it, so this time processes and agents stop when Crew quits. Move Crew to Applications and open it again.";

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
  // Loaded if it is not (after a reboot it never is), then kickstarted. A
  // stale daemon.json is left for crewd, which renames its own over it: the
  // app removing it could only ever race a crewd that just wrote a fresh one.
  | { do: "start" }
  // `kickstart -k`: SIGTERM to the one that does not answer, then a new one.
  | { do: "restart" }
  // Asked to exit (`daemon/shutdown`, so it stops its processes the usual
  // way and the auto-start ones come back), then started.
  | { do: "replace"; file: DaemonFile };

// On launch. The one place a daemon of another version is replaced: the plist
// has just been made to run this bundle's crewd, so what launchd starts in its
// place is this version.
export function nextStep(found: Found): Step {
  switch (found.kind) {
    case "ready":
      return { do: "connect", file: found.file };
    case "missing":
    case "stale":
      return { do: "start" };
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

export type WatchStep =
  | { do: "start" }
  | { do: "restart" }
  | { do: "keep" }
  | { do: "switch"; file: DaemonFile }
  | { do: "wait" }
  // Another version is serving: said once, then left alone.
  | { do: "warn"; file: DaemonFile }
  | { do: "leave" };

// While the app runs: `current` is the daemon it is connected to, `strikes`
// how many checks in a row found it not answering, `warned` the version it
// last said was running instead of its own.
//
// Another version is never replaced from here. Whatever started it (the app
// updated under a window still open, another copy's plist) starts it again:
// replacing it meant stopping every process only for launchd to run that
// same crewd, every ten seconds, for as long as the window stayed open.
export function watchStep(found: Found, current: DaemonFile | null, strikes: number, warned: string | null = null): WatchStep {
  switch (found.kind) {
    case "ready":
      return sameDaemon(found.file, current) ? { do: "keep" } : { do: "switch", file: found.file };
    case "unreachable":
      return strikes + 1 >= HUNG_STRIKES ? { do: "restart" } : { do: "wait" };
    case "mismatch":
      return found.file.version === warned ? { do: "leave" } : { do: "warn", file: found.file };
    case "missing":
    case "stale":
      return { do: "start" };
  }
}

export function mismatchNotice(running: string, app: string): string {
  return `Crew's background service is now version ${running} and this window is ${app}. Quit Crew and open it again to bring them together.`;
}

// How a packaged launch ends. The LaunchAgent is tried first; if it cannot be
// installed, loaded or reached, this run falls back to the dev way, crewd as
// the app's child, so Crew still opens, and only its processes stop with it.
// `notice`, for an agent that was never tried, says why in place of the usual.
export type Outcome = { ok: true } | { ok: false; error: string; notice?: string };

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
  if (child.ok) return { run: "child", notice: agent.notice ?? CHILD_NOTICE, why: agent.error };
  return { run: "none", dialog: `Could not start crewd.\n\nAs a LaunchAgent: ${agent.error}\n\nAs Crew's child: ${child.error}` };
}
