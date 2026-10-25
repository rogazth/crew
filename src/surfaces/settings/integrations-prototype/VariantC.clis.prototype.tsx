// PROTOTYPE — throwaway. Variant C's "From your providers": the servers each
// CLI has set up on its own machine, one chip per server however many CLIs and
// machines have it: its mark, its name, and a word when something's off. A
// click opens its page (VariantC.detail), with every copy (CLI on machine).
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import type { MenuAction } from "../../../lib/menu";
import { RowAction, RowMenu } from "./VariantC.bits.prototype";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { ServiceMark } from "./parts.prototype";
import { TONE_BG, openServer, type Tone } from "./VariantC.lib.prototype";
import { TileSection } from "./VariantC.sections.prototype";
import {
  PROVIDER_IDS,
  PROVIDER_NAMES,
  actions,
  machineOf,
  serviceOf,
  useIntegrations,
  type MachineId,
  type ProviderServer,
  type State,
} from "./store.prototype";

/** One server: every copy of it, on every machine and in every CLI, machines first and CLIs in their listed order. */
export type Group = { key: string; name: string; servers: ProviderServer[] };

const keyOf = (server: ProviderServer) => server.serviceId ?? server.name;
const MACHINE_ORDER: MachineId[] = ["local", "devbox", "gpu"];

export function groupsOf(s: State): Group[] {
  const out = new Map<string, Group>();
  const servers = [...s.servers].sort(
    (a, b) => MACHINE_ORDER.indexOf(a.machine) - MACHINE_ORDER.indexOf(b.machine) || PROVIDER_IDS.indexOf(a.provider) - PROVIDER_IDS.indexOf(b.provider),
  );
  for (const server of servers) {
    const key = keyOf(server);
    const group = out.get(key) ?? { key, name: serviceOf(server.serviceId)?.name ?? server.name, servers: [] };
    group.servers.push(server);
    out.set(key, group);
  }
  // What needs you first, then what didn't start last time, then the most widely set up.
  const has = (g: Group, state: ProviderServer["state"]) => g.servers.some((x) => !x.offInCrew && x.state === state);
  const rank = (g: Group) => (has(g, "needs-auth") ? 0 : has(g, "failed") ? 1 : 2);
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || b.servers.length - a.servers.length);
}

/** A server without a registry service shows its CLI's mark instead. */
export function ServerMark({ server, size }: { server: ProviderServer; size: number }) {
  const service = serviceOf(server.serviceId);
  if (service) return <ServiceMark service={service} size={size} />;
  return (
    <span className="grid shrink-0 place-items-center rounded-[26%] bg-surface shadow-[inset_0_0_0_1px_var(--color-hairline)]" style={{ width: size, height: size }}>
      <ProviderIcon provider={server.provider} className="size-1/2" />
    </span>
  );
}

export function busy(s: State, server: ProviderServer): boolean {
  return server.state === "pending" || s.flows.some((f) => f.kind === "server" && f.target === server.id && f.stage !== "done");
}

export const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** Where a group is set up: its CLIs, then its machines. */
function whereOf(s: State, servers: ProviderServer[]): string {
  const clis = uniq(servers.map((x) => x.provider));
  const machines = uniq(servers.map((x) => x.machine));
  const cliText = clis.length > 2 ? `${clis.length} CLIs` : clis.map((x) => PROVIDER_NAMES[x]).join(", ");
  const machineText = machines.length > 2 ? `${machines.length} machines` : machines.map((m) => machineOf(s, m).name).join(", ");
  return `${cliText} · ${machineText}`;
}

/** The row's dot and line: the worst copy speaks for the group. */
/**
 * The chip's dot and word: the worst copy speaks for the group. A failed start isn't broken for good: every
 * new session starts the server again, so it says what happened last time, not that it's down.
 */
export function statusOf(s: State, group: Group): { tone: Tone | undefined; text: string; short?: string } {
  const on = group.servers.filter((x) => !x.offInCrew);
  if (group.servers.some((x) => s.flows.some((f) => f.kind === "server" && f.target === x.id && f.stage !== "done")))
    return { tone: "info", text: "Authenticating…", short: "Authenticating…" };
  if (group.servers.some((x) => x.state === "pending")) return { tone: "info", text: `Starting… · ${whereOf(s, group.servers)}` };
  if (on.length === 0) return { tone: undefined, text: `Off · ${whereOf(s, group.servers)}` };
  const failed = on.find((x) => x.state === "failed");
  if (failed) return { tone: "warning", text: `Didn’t start last time · ${PROVIDER_NAMES[failed.provider]} on ${machineOf(s, failed.machine).name}`, short: "Didn’t start" };
  const auth = on.find((x) => x.state === "needs-auth");
  if (auth) return { tone: "warning", text: `Needs authentication · ${PROVIDER_NAMES[auth.provider]} on ${machineOf(s, auth.machine).name}`, short: "Needs auth" };
  return { tone: "success", text: whereOf(s, group.servers) };
}

export function FromProviders() {
  const s = useIntegrations();
  const groups = groupsOf(s);
  const offline = s.machines.filter((m) => !m.online && s.servers.some((x) => x.machine === m.id));
  return (
    <div className="flex flex-col gap-2">
      <TileSection
        title="From your providers"
        count={groups.length}
        level="secondary"
        layout="chips"
        fold={Infinity}
      >
        {groups.map((group) => (
          <ProviderChip key={group.key} group={group} />
        ))}
      </TileSection>
      {offline.length > 0 && (
        <p className="px-1 text-[12px] text-text-muted">{offline.map((m) => m.name).join(", ")} is offline. Showing its last report.</p>
      )}
      {groups.length === 0 && <p className="px-1 text-[12px] text-text-muted">No servers in your CLIs.</p>}
    </div>
  );
}

/** One server as a chip: its mark and its name, and a dot only when something's off. The rest is on its page. */
function ProviderChip({ group }: { group: Group }) {
  const s = useIntegrations();
  const status = statusOf(s, group);
  const on = group.servers.some((x) => !x.offInCrew);
  return (
    <button
      type="button"
      onClick={() => openServer(group.key)}
      className="flex h-11 min-w-0 items-center gap-2.5 rounded-lg bg-card px-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <span className={`relative shrink-0 ${on ? "" : "opacity-45 grayscale"}`}>
        <ServerMark server={group.servers[0]!} size={22} />
        {on && (status.tone === "warning" || status.tone === "danger") && <span className={`absolute -right-[2px] -bottom-[2px] size-2 rounded-full ring-2 ring-canvas ${TONE_BG[status.tone]}`} />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? "" : "text-text-muted line-through decoration-text-muted/50"}`}>{group.name}</span>
    </button>
  );
}

/**
 * One copy: the CLI and where it's set up, or what's wrong and its one fix. Disabling it for Crew's sessions
 * and removing just this copy are behind ⋯; removing them all is the page's trash.
 */
const SCOPE: Record<ProviderServer["scope"], string> = {
  user: "User config",
  project: "Project config",
  plugin: "From a plugin",
  "claude.ai": "From claude.ai",
};

export function CliRow({ server, onUninstall }: { server: ProviderServer; onUninstall?: (() => void) | undefined }) {
  const s = useIntegrations();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const cli = PROVIDER_NAMES[server.provider];
  const working = busy(s, server);
  const live = !server.offInCrew && !working;
  const status = working
    ? server.state === "pending"
      ? "Starting…"
      : "Authenticating…"
    : server.offInCrew
      ? "Disabled"
      : server.state === "needs-auth"
        ? "Needs authentication"
        : server.state === "failed"
          ? `Didn’t start last time · ${server.error}`
          : // The tokens are the server's, the same in every copy: they're in the page's header. A copy says where it's set up.
            SCOPE[server.scope];
  // Not down for good: every new session starts it again, so the fix is only to try now.
  const fix = live && server.state === "needs-auth" ? { label: "Authenticate", run: () => actions.signInServer(server.id) } : live && server.state === "failed" ? { label: "Try now", run: () => actions.retryServer(server.id) } : null;
  const problem = !!fix;
  const menu: Omit<MenuAction, "hotkey">[] = [
    server.offInCrew ? { id: "on", label: "Enable", icon: "enable" } : { id: "off", label: "Disable", icon: "disable" },
    ...(onUninstall ? [{ id: "remove", label: "Remove", icon: "delete" as const, danger: true }] : []),
  ];
  const pick = (id: string) => {
    if (id === "remove" && onUninstall)
      return setConfirm({ title: `Remove ${serviceOf(server.serviceId)?.name ?? server.name} from ${cli}?`, description: "This action can’t be undone.", action: "Remove", onConfirm: onUninstall });
    actions.setOffInCrew(server.id, id === "off");
  };
  return (
    // Two lines always: the CLI, then where it's set up or what's wrong; a dot on the CLI's mark when something's off.
    <div className="flex h-14 items-center gap-2.5 border-t border-hairline first:border-t-0">
      <span className={`relative ml-1 flex shrink-0 ${server.offInCrew ? "opacity-45 grayscale" : ""}`}>
        <ProviderIcon provider={server.provider} className="size-4" />
        {problem && <span className="absolute -right-[3px] -bottom-[3px] size-2 rounded-full bg-warning ring-2 ring-card" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col" title={server.error}>
        <span className={`font-medium ${server.offInCrew ? "text-text-muted" : ""}`}>{cli}</span>
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${working ? "text-info" : "text-text-muted"}`}>
          {working && <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />}
          <span className="truncate">{status}</span>
        </span>
      </span>
      {fix && <RowAction label={fix.label} onClick={fix.run} />}
      <RowMenu label={`More for ${cli}`} actions={menu} onPick={pick} />
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
