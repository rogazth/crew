// The servers each provider CLI has on one machine, read the way the
// Connectors page shows them: one chip per server name however many CLIs have
// it, each copy's line, and the section's one-line summary. Pure: the store
// is providers.ts, the components clis.tsx.
import type { ProviderInventory, ProviderServer, RegistryServer } from "../../../lib/protocol";
import type { ProviderId } from "../../../lib/providers";
import { PROVIDER_META } from "../providerMeta";
import { brandOfServer as brandOfRegistry, serverName, type Brand } from "./brand";
import type { Tone } from "./lib";

export type Server = ProviderServer;

/** The CLIs in the order the page lists them. */
export const PROVIDER_ORDER = ["claude", "codex", "cursor", "opencode", "grok"];

/** Cursor and Grok have no per-spawn way to leave a server out: their switch writes the CLI's config. */
const PER_SPAWN: Record<string, boolean> = { claude: true, codex: true, opencode: true, cursor: false, grok: false };
export const perSpawn = (provider: string) => PER_SPAWN[provider] ?? false;

export const providerName = (provider: string) => PROVIDER_META[provider as ProviderId]?.name ?? provider;

/** One server in one CLI on one machine. */
export const serverKey = (server: { provider: string; name: string }) => `${server.provider}\u0000${server.name}`;

/** Servers a CLI's own desktop app installs for itself (Codex's computer use, its app tools): not the person's to manage. */
export const isBundled = (server: Server) => server.scope === "bundled";

/** What the registry says a server is, when its URL is one the registry knows. */
export type RegistryOf = (server: Server) => RegistryServer | undefined;

/** The name a copy is shown by: claude.ai's connectors without "claude.ai", a plugin's without "plugin:<plugin>:". */
export const displayName = (server: Server) => server.name.replace(/^claude\.ai\s+/i, "").replace(/^plugin:[^:]+:/, "");

/** Off for Crew's sessions: left out by Crew, or disabled in the CLI itself. */
export const isOff = (server: Server) => server.offInCrew || server.state === "disabled";

const rankOf = (provider: string) => {
  const at = PROVIDER_ORDER.indexOf(provider);
  return at < 0 ? PROVIDER_ORDER.length : at;
};

/** "a", "a and b", "a, b and c". */
export function listJoin(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One server: its copy in every CLI on the machine that has it, in the CLIs'
 * order. Copies are the same server when the registry knows their URL as one
 * entry, else when they share a name.
 */
export type Group = { key: string; name: string; servers: Server[]; registry: RegistryServer | undefined };

/** What a copy is doing in this window: a sign-in under way, a new try, or a removal. */
export type Busy = "signing-in" | "starting" | "checking" | "removing" | null;

/**
 * Every server on the machine, grouped by name: what needs the person first,
 * then what didn't start last time, then the most widely set up.
 */
export function groupsOf(inventory: ProviderInventory[], registryOf: RegistryOf = () => undefined): Group[] {
  const out = new Map<string, Group>();
  const servers = inventory
    .flatMap((i) => i.servers)
    .filter((x) => !isBundled(x))
    .sort((a, b) => rankOf(a.provider) - rankOf(b.provider));
  // A CLI with two copies of one registry server has them as two accounts
  // (figma-work, figma-home): those keep their own names, with its mark.
  const copies = new Map<string, number>();
  for (const server of servers) {
    const registry = registryOf(server);
    if (registry) copies.set(`${registry.name}\u0000${server.provider}`, (copies.get(`${registry.name}\u0000${server.provider}`) ?? 0) + 1);
  }
  const split = new Set([...copies].filter(([, n]) => n > 1).map(([key]) => key.split("\u0000")[0]!));
  for (const server of servers) {
    const registry = registryOf(server);
    const merged = registry && !split.has(registry.name);
    const key = merged ? `registry:${registry.name}` : displayName(server).toLowerCase();
    const group = out.get(key) ?? { key, name: merged ? serverName(registry) : displayName(server), servers: [], registry };
    group.servers.push(server);
    out.set(key, group);
  }
  const has = (g: Group, state: Server["state"]) => g.servers.some((x) => !isOff(x) && x.state === state);
  const rank = (g: Group) => (has(g, "needs_auth") ? 0 : has(g, "failed") ? 1 : 2);
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || b.servers.length - a.servers.length || a.name.localeCompare(b.name));
}

/** Its CLIs, for a line: two by name, more as a count. */
function whereOf(servers: Server[]): string {
  const clis = [...new Set(servers.map((x) => x.provider))];
  return clis.length > 2 ? `${clis.length} CLIs` : clis.map(providerName).join(", ");
}

/**
 * The chip's dot and line: the worst copy speaks for the group. A failed
 * start isn't broken for good: every new session starts the server again, so
 * it says what happened last time, not that it's down.
 */
export function groupStatus(group: Group, busy: (server: Server) => Busy): { tone: Tone | undefined; text: string } {
  const on = group.servers.filter((x) => !isOff(x));
  if (group.servers.some((x) => busy(x) === "signing-in")) return { tone: "info", text: "Signing in…" };
  if (on.some((x) => x.state === "pending" || busy(x) === "starting")) return { tone: "info", text: `Starting… · ${whereOf(group.servers)}` };
  if (on.length === 0) return { tone: undefined, text: `Off · ${whereOf(group.servers)}` };
  const failed = on.find((x) => x.state === "failed");
  if (failed) return { tone: "warning", text: `Failed to start · ${providerName(failed.provider)}` };
  const auth = on.find((x) => x.state === "needs_auth");
  if (auth) return { tone: "warning", text: `Sign in required · ${providerName(auth.provider)}` };
  return { tone: "success", text: whereOf(group.servers) };
}

const SCOPE: Record<string, string> = {
  user: "User config",
  project: "Project config",
  local: "Local config",
  plugin: "From a plugin",
  "claude.ai": "From claude.ai",
};

/** Where a copy is set up, as its line says it. */
export function scopeLine(server: Server): string {
  const scope = (server.scope && SCOPE[server.scope]) ?? `${providerName(server.provider)}’s config`;
  return server.tools === null ? scope : `${scope} · ${plural(server.tools, "tool")}`;
}

/** A claude.ai connector is signed in at claude.ai, never from here. */
export const managedAtClaudeAi = (server: Server) => server.scope === "claude.ai" || server.transport === "claude.ai";

/** A copy's one fix on its row. */
export type Fix = "sign-in" | "claude.ai" | "retry" | null;

/**
 * One copy's line and its fix: what's wrong and the one thing to do, or else
 * where it's set up. `working` lines spin.
 */
export function rowStatus(server: Server, busy: Busy): { text: string; working: boolean; problem: boolean; fix: Fix } {
  const cli = providerName(server.provider);
  if (busy === "signing-in") return { text: "Signing in…", working: true, problem: false, fix: null };
  if (busy === "checking") return { text: "Checking…", working: true, problem: false, fix: null };
  if (busy === "removing") return { text: "Removing…", working: true, problem: false, fix: null };
  if (server.offInCrew) return { text: perSpawn(server.provider) ? "Off" : "Off, also outside the app", working: false, problem: false, fix: null };
  if (server.state === "disabled") return { text: `Disabled in ${cli}`, working: false, problem: false, fix: null };
  if (busy === "starting" || server.state === "pending") return { text: "Starting…", working: true, problem: false, fix: null };
  if (server.state === "needs_auth") {
    if (server.canSignIn) return { text: "Sign in required", working: false, problem: true, fix: "sign-in" };
    if (managedAtClaudeAi(server)) return { text: "Sign in required · Managed at claude.ai", working: false, problem: true, fix: "claude.ai" };
    return { text: `Sign in required · Sign in from ${cli}`, working: false, problem: true, fix: null };
  }
  if (server.state === "failed")
    return { text: server.error ? `Failed to start · ${server.error}` : "Failed to start", working: false, problem: true, fix: "retry" };
  return { text: scopeLine(server), working: false, problem: false, fix: null };
}

function hostOf(target: string): string | null {
  if (!/^https?:\/\//.test(target)) return null;
  try {
    return new URL(target).hostname;
  } catch {
    return null;
  }
}

/**
 * What a server's mark is drawn from: a remote one's host (its favicon, else a
 * monogram), a claude.ai connector's name; a local command has none, and shows
 * its CLI's mark instead.
 */
export function brandOfServer(server: Server, registry?: RegistryServer): Brand | null {
  if (registry) return brandOfRegistry(registry);
  const host = hostOf(server.target);
  const name = displayName(server);
  if (host) return { id: server.name, name, publisher: host, logo: null };
  if (managedAtClaudeAi(server)) return { id: server.name, name, publisher: "", logo: null };
  return null;
}

/** The header's line on a server's page: its tools, and where it runs. */
export function serverLine(server: Server): string {
  const host = hostOf(server.target);
  const where = host ?? (managedAtClaudeAi(server) ? "claude.ai" : "Runs on the machine");
  return server.tools === null ? where : `${plural(server.tools, "tool")} · ${where}`;
}
