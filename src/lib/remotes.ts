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
  port?: number;
};

export type InstallStepId = "reach" | "ssh" | "upload" | "service" | "pair" | "clis";

export type InstallStep = {
  id: InstallStepId;
  state: "running" | "done" | "error";
  detail?: string;
  /** "install" for a new machine; a machine's id while it updates. */
  job: string;
};

export const INSTALL_JOB = "install";

export const INSTALL_STEPS: { id: InstallStepId; label: string }[] = [
  { id: "reach", label: "Reach the machine" },
  { id: "ssh", label: "Sign in over SSH" },
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
