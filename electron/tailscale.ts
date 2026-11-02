import type { Tailnet, TailscaleDevice } from "../src/lib/remotes";
import { errorText, trace } from "./trace";

type Peer = {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  Online?: boolean;
  TailscaleIPs?: string[];
  CurAddr?: string;
  Relay?: string;
  UserID?: number;
};

type Status = {
  BackendState?: string;
  Self?: Peer;
  Peer?: Record<string, Peer>;
  User?: Record<string, { LoginName?: string }>;
  CurrentTailnet?: { Name?: string };
};

/**
 * The environment to run Tailscale's Mac binary in. Without TERM or SHLVL, as in
 * an app opened from Finder, it starts as the GUI instead of the CLI and fails.
 */
export function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, TERM: env.TERM ?? "dumb" };
}

/** What the CLI printed into a Tailnet. Anything but JSON is Tailscale's own error, shown as it said it. */
export function tailnetFromOutput(stdout: string, added: ReadonlySet<string>): Tailnet {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    const message = stdout.trim().split("\n")[0] || "Tailscale said nothing";
    trace.warn("tailscale.status_failed", { error: errorText(message) });
    return { state: "error", account: null, message, devices: [] };
  }
  return tailnetFrom(raw, added);
}

/** `tailscale status --json` into what Settings shows: the account, and the rows the add flow offers. */
export function tailnetFrom(raw: unknown, added: ReadonlySet<string>): Tailnet {
  if (!raw || typeof raw !== "object") return { state: "error", account: null, message: "Tailscale said nothing", devices: [] };
  const status = raw as Status;
  const backend = status.BackendState ?? "";
  if (backend !== "Running") {
    const message = backend === "NeedsLogin" ? "Tailscale is signed out" : "Tailscale is not running";
    return { state: "stopped", account: null, message, devices: [] };
  }
  const selfUser = status.Self?.UserID;
  const account =
    (selfUser !== undefined ? status.User?.[String(selfUser)]?.LoginName : undefined) ?? status.CurrentTailnet?.Name ?? null;
  return { state: "running", account, message: null, devices: devicesFrom(status, added) };
}

/** The rows the add flow shows. Self is this Mac. */
export function devicesFrom(raw: unknown, added: ReadonlySet<string>): TailscaleDevice[] {
  if (!raw || typeof raw !== "object") return [];
  const status = raw as Status;
  const rows: TailscaleDevice[] = [];
  if (status.Self) {
    const self = device(status.Self, added, true);
    if (self) rows.push(self);
  }
  const everyone = [...(status.Self ? [status.Self] : []), ...Object.values(status.Peer ?? {})];
  noteWithoutAddress(everyone.filter((peer) => !ipOf(peer)).length);
  const peers = Object.values(status.Peer ?? {})
    .map((peer) => device(peer, added, false))
    .filter((row): row is TailscaleDevice => row !== null)
    // Machines that can be added first, then the rest, each by name.
    .sort((a, b) => Number(a.reason !== null) - Number(b.reason !== null) || a.host.localeCompare(b.host));
  rows.push(...peers);
  return rows;
}

const ipOf = (peer: Peer) => (peer.TailscaleIPs ?? []).find((item) => item.includes(".") && !item.includes(":"));

/** Devices Tailscale lists with no IPv4 address cannot be added. Said when the count changes, not at every look. */
let withoutAddress = 0;
function noteWithoutAddress(count: number): void {
  if (count === withoutAddress) return;
  withoutAddress = count;
  if (count > 0) trace.info("tailscale.no_address", { devices: count });
}

function device(peer: Peer, added: ReadonlySet<string>, self: boolean): TailscaleDevice | null {
  const ip = ipOf(peer);
  if (!ip) return null;
  const host = peer.HostName?.trim() || ip;
  const dns = (peer.DNSName ?? "").replace(/\.$/, "");
  const os = osName(peer.OS);
  const online = self || peer.Online === true;
  const relay = !self && online && !peer.CurAddr && !!peer.Relay;
  return {
    host,
    dns,
    ip,
    os,
    online,
    self,
    relay,
    reason: why(peer, ip, dns, added, self),
  };
}

function osName(os: string | undefined): string {
  const value = os?.trim() ?? "";
  const names: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows", ios: "iOS", android: "Android" };
  return names[value.toLowerCase()] ?? (value || "Unknown");
}

function why(peer: Peer, ip: string, dns: string, added: ReadonlySet<string>, self: boolean): string | null {
  if (self) return "This Mac";
  const host = peer.HostName ?? "";
  if (added.has(ip) || (host && added.has(host)) || (dns && added.has(dns))) return "Added";
  if ((peer.OS ?? "").toLowerCase() !== "linux") return `${osName(peer.OS)} isn't supported`;
  if (peer.Online !== true) return "Offline";
  return null;
}
