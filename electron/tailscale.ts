import type { Tailnet, TailscaleDevice } from "../src/lib/remotes";

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
  const peers = Object.values(status.Peer ?? {})
    .map((peer) => device(peer, added, false))
    .filter((row): row is TailscaleDevice => row !== null)
    // Machines that can be added first, then the rest, each by name.
    .sort((a, b) => Number(a.reason !== null) - Number(b.reason !== null) || a.host.localeCompare(b.host));
  rows.push(...peers);
  return rows;
}

function device(peer: Peer, added: ReadonlySet<string>, self: boolean): TailscaleDevice | null {
  const ip = (peer.TailscaleIPs ?? []).find((item) => item.includes(".") && !item.includes(":"));
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
