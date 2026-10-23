import type { RemoteEnv } from "./protocol";

export type { RemoteEnv };

/** One peer from `tailscale status`. `reason` is why it cannot be added. */
export type TailscaleDevice = {
  host: string;
  dns: string;
  ip: string;
  os: string;
  online: boolean;
  self: boolean;
  relay: boolean;
  reason: string | null;
};

/** Tailscale on this Mac, as Settings shows it. `devices` is empty unless it runs. */
export type Tailnet = {
  state: "running" | "stopped" | "missing" | "error";
  /** The signed-in login, or the tailnet's name. */
  account: string | null;
  message: string | null;
  devices: TailscaleDevice[];
};

/** A Host from the user's ~/.ssh/config, as `ssh -G` resolves it. */
export type SshHost = { alias: string; hostname: string; user: string; port: number };

export type InstallInput = {
  name: string;
  /** What `ssh` is given: a Host from ~/.ssh/config, a tailnet IP, or a name. */
  ssh: string;
  /** Empty to let ~/.ssh/config (or the Mac's login) pick it. */
  user: string;
  /** The port crewd listens on (the proxy takes the next one). */
  port?: number;
  /** The port ssh dials, when it is not the one ~/.ssh/config (or 22) gives. */
  sshPort?: number;
};

export type InstallStepId = "reach" | "ssh" | "existing" | "upload" | "service" | "pair" | "clis";

/** Why a step failed, in words that say what to do. Anything not recognised has only `message`. */
export type InstallFailure = {
  code: "unreachable" | "auth" | "port" | "other";
  message: string;
  hint: string;
  /** A command to copy and run, when there is one. */
  fix?: string;
};

export type InstallStep = {
  id: InstallStepId;
  /** "skipped": a crewd that already runs there needs no upload or service. */
  state: "running" | "done" | "error" | "skipped";
  detail?: string;
  /** Bytes sent and in all, while the upload runs. */
  received?: number;
  total?: number;
  failure?: InstallFailure;
  /** "install" for a new machine; a machine's id while it updates. */
  job: string;
};

export const INSTALL_JOB = "install";

export const INSTALL_STEPS: { id: InstallStepId; label: string }[] = [
  { id: "reach", label: "Reach the machine" },
  { id: "ssh", label: "Sign in over SSH" },
  { id: "existing", label: "Look for an existing crewd" },
  { id: "upload", label: "Upload crewd" },
  { id: "service", label: "Start the service" },
  { id: "pair", label: "Pair" },
  { id: "clis", label: "Look for agent CLIs" },
];

/** A daemon that is already listening. The token is stored in the keychain, not in the daemon's database. */
export type ManualRemote = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  ssh?: string;
  token: string;
};

/** 7777 is Orca's. crewd listens here, and SOCKS on the port after it. */
export const DEFAULT_PORT = 17877;

/**
 * A machine kept at its loopback: crewd there never listens beyond it (no
 * Tailscale on that machine), and this Mac reaches it through an ssh tunnel.
 */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** The state key of "Update machines automatically": on unless it says "off". */
export const AUTO_UPDATE = "remote:auto-update";

/**
 * A machine whose crewd is behind this Mac's, as main's updater holds it:
 * `waiting` for its sessions to finish (or to stay idle a while), `updating`
 * now. A machine that is up to date has none.
 */
export type RemoteUpdateState = {
  state: "waiting" | "updating";
  /** The version it is brought to. */
  version: string;
  /** The user asked for it, rather than the automatic setting. */
  queued: boolean;
  agentsRunning: number;
};

/** How an update main started on its own ended, for the window to say. */
export type RemoteUpdateResult = { id: string; name: string; version: string; ok: boolean; message: string | null };

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** An error in words for the UI, without Electron's "Error invoking remote method" wrapper. */
export function errorText(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
