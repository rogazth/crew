/**
 * How a remote workspace's pages reach its machine's loopback while every page
 * shares one session. A session has one proxy, so the machine is in the name:
 * `localhost:3000` on the machine called sandbox is `sandbox.localhost:3000`.
 * Chromium keeps any `*.localhost` on loopback, where the relay (see
 * electron/browser/remote-proxy.ts) takes it to that machine. Imported by main
 * and the window, so it stays free of DOM and Electron.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * A request for plain `localhost` from a remote workspace's page carries its
 * machine here, so a URL the page's code spells out still reaches the machine.
 * Only a plain-HTTP request shows its headers to the relay.
 */
export const MACHINE_HEADER = "x-crew-machine";

/** Whether `alias` could be one: one DNS label, as `machineAliases` makes them. */
export function isMachineAlias(alias: unknown): alias is string {
  return typeof alias === "string" && LABEL.test(alias);
}

/** A machine's name as a DNS label: lowercase, accents gone, anything else a dash. */
function slug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return base || "machine";
}

/**
 * Each machine's alias, by its id. Two machines with the same name are told
 * apart by a number, given in id order so each keeps its own across launches.
 */
export function machineAliases(machines: readonly { id: string; name: string }[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const taken = new Set<string>();
  for (const machine of [...machines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const base = slug(machine.name);
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
    taken.add(alias);
    aliases.set(machine.id, alias);
  }
  return aliases;
}

/** `localhost`, `127.x` or `::1`: this Mac's loopback, with no machine named. */
export function isPlainLoopback(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** The machine a `*.localhost` name points at: its last label before `localhost`. */
export function aliasOfHost(hostname: string): string | null {
  const bare = hostname.toLowerCase().replace(/\.$/, "");
  if (!bare.endsWith(".localhost")) return null;
  const label = bare.slice(0, -".localhost".length).split(".").at(-1) ?? "";
  return isMachineAlias(label) ? label : null;
}

/**
 * `url` as a page of a workspace on `alias` should load it: plain loopback
 * becomes the machine's name, port, path and all. Anything else is untouched,
 * and so is everything when the workspace is on this Mac.
 */
export function onMachine(url: string, alias: string | null): string {
  if (!alias) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  if (!isPlainLoopback(parsed.hostname)) return url;
  parsed.hostname = `${alias}.localhost`;
  return parsed.toString();
}

/**
 * A request's headers with MACHINE_HEADER set only by Crew: whatever a page
 * put there is dropped, and a plain-HTTP request for plain loopback from a
 * remote workspace's page names its machine.
 */
export function machineHeaders(headers: Record<string, string>, url: string, alias: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== MACHINE_HEADER) out[name] = value;
  if (!alias) return out;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && isPlainLoopback(parsed.hostname)) out[MACHINE_HEADER] = alias;
  } catch {
    // Not a URL a proxy sees.
  }
  return out;
}

/** What the window tells main about one machine: `socksPort` is null while it is not reachable. */
export type MachineRoute = { alias: string; envId: string; socksPort: number | null };
