// "From your providers": the servers each CLI has set up on one machine (the
// one Providers shows, picked the same way), one chip per server however many
// CLIs have it: its mark, its name, and a dot when something's off. A click
// opens its page (detail.tsx), with its copy in each CLI. Every call goes to
// that machine's daemon (providers.ts).
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { useEnvLinks, useEnvStates } from "../../../hooks/useEnvLinks";
import { LOCAL, type EnvLink } from "../../../lib/client/registry";
import type { MenuAction } from "../../../lib/menu";
import { EnvPicker } from "../ProviderList";
import { useProvidersEnv } from "../route";
import { RowAction, RowMenu } from "./bits";
import { TONE_BG, openServer } from "./lib";
import { ServiceMark } from "./mark";
import { serverActions, useProviderServers, type MachineView } from "./providers";
import { TileSection } from "./sections";
import type { RegistryServer } from "../../../lib/protocol";
import { brandOfServer, displayName, groupStatus, groupsOf, isOff, perSpawn, providerName, rowStatus, type Group, type Server } from "./servers";

/** The machine the provider sections show: Providers' pick, else this Mac. */
function useServersMachine(): { link: EnvLink | undefined; links: EnvLink[] } {
  const links = useEnvLinks();
  const viewing = useProvidersEnv();
  return { link: links.find((l) => l.id === viewing) ?? links[0], links };
}

/** A server's mark: the registry's, else its host's favicon, else its name's monogram. */
export function ServerMark({ server, size, registry }: { server: Server; size: number; registry?: RegistryServer | undefined }) {
  // A local command has no host to draw a mark from: its name's monogram, never its CLI's mark.
  const brand = brandOfServer(server, registry) ?? { id: displayName(server), name: displayName(server), publisher: "", logo: null };
  return <ServiceMark brand={brand} size={size} />;
}

export function FromProviders() {
  const { link, links } = useServersMachine();
  if (!link) return null;
  return <MachineServers key={link.id} link={link} links={links} />;
}

function MachineServers({ link, links }: { link: EnvLink; links: EnvLink[] }) {
  const m = useProviderServers(link.id);
  // Nothing until the registry has named every server, so chips don't merge in front of the person.
  const groups = m.settled ? groupsOf(m.inventory, m.registryOf) : [];
  // This Mac's daemon is the window's own; only a remote is ever away.
  const live = link.id === LOCAL || (link.status === "online" && !link.mismatch);
  return (
    <div className="flex flex-col gap-2">
      <TileSection
        title="From your providers"
        count={m.settled && groups.length > 0 ? groups.length : undefined}
        layout="chips"
        fold={Infinity}
        // As on Providers: one machine at a time, and only when there is another.
        action={links.length > 1 ? <EnvPicker small link={link} links={links} /> : undefined}
      >
        {groups.map((group) => (
          <ProviderChip key={group.key} envId={link.id} group={group} m={m} />
        ))}
      </TileSection>
      {!live && m.inventory.length > 0 && <p className="px-1 text-[12px] text-text-muted">{link.name} is offline. Showing its last report.</p>}
      {live && m.error && <p className="px-1 text-[12px] text-danger">Couldn’t read the servers: {m.error}</p>}
    </div>
  );
}

/** One server as a chip: its mark and its name, and a dot only when something's off. The rest is on its page. */
function ProviderChip({ envId, group, m }: { envId: string; group: Group; m: MachineView }) {
  const status = groupStatus(group, m.busy);
  const on = group.servers.some((x) => !isOff(x));
  return (
    <button
      type="button"
      title={status.text}
      onClick={() => openServer(envId, group.key, group.name)}
      className="relative flex h-11 min-w-0 items-center gap-2.5 rounded-lg bg-card px-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <span className={`relative shrink-0 ${on ? "" : "opacity-45 grayscale"}`}>
        <ServerMark server={group.servers[0]!} registry={group.registry} size={22} />
        {on && (status.tone === "warning" || status.tone === "danger") && <span className={`absolute -right-[2px] -bottom-[2px] size-2 rounded-full ring-2 ring-canvas ${TONE_BG[status.tone]}`} />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? "" : "text-text-muted line-through decoration-text-muted/50"}`}>{group.name}</span>
    </button>
  );
}

/** Why a copy can't be removed from here, and where it can. */
function removeHint(server: Server, cli: string): string {
  if (server.scope === "claude.ai") return "Managed at claude.ai";
  if (server.scope === "project") return "Set in this project’s config";
  return `Only ${cli} can remove it`;
}

/**
 * One copy: the CLI and where it's set up, or what's wrong and its one fix.
 * Disabling it for Crew's sessions is behind ⋯; for Cursor and Grok, which
 * have no per-session way, that writes the CLI's own config, so it says so
 * and asks first.
 */
export function CliRow({ envId, server, m }: { envId: string; server: Server; m: MachineView }) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const cli = providerName(server.provider);
  const env = useEnvStates().find((l) => l.id === envId);
  const here = envId === LOCAL || !env ? "this Mac" : env.name;
  const busy = m.busy(server);
  const status = rowStatus(server, busy);
  const outside = !perSpawn(server.provider);
  const fix =
    status.fix === "sign-in"
      ? { label: "Sign in", run: () => serverActions.signIn(envId, server) }
      : status.fix === "claude.ai"
        ? { label: "Open claude.ai", run: serverActions.openClaudeAi }
        : status.fix === "retry"
          ? { label: "Try now", run: () => serverActions.retry(envId, server) }
          : null;
  const menu: Omit<MenuAction, "hotkey">[] = [
    server.offInCrew
      ? { id: "on", label: "Enable", icon: "enable" }
      : { id: "off", label: "Disable", icon: "disable" },
    { id: "remove", label: "Remove", icon: "delete", danger: server.canRemove, disabled: !server.canRemove, ...(server.canRemove ? {} : { hint: removeHint(server, cli) }) },
  ];
  const pick = (id: string) => {
    if (id === "remove")
      return setConfirm({
        title: `Remove ${displayName(server)}?`,
        description: `Removes it from ${cli} on ${here}.`,
        action: "Remove",
        onConfirm: () => serverActions.remove(envId, server),
      });
    const off = id === "off";
    if (off && outside)
      return setConfirm({
        title: `Disable ${displayName(server)}?`,
        description: `Turns it off in ${cli} on ${here}.`,
        action: "Disable",
        onConfirm: () => serverActions.setOff(envId, server, true),
      });
    serverActions.setOff(envId, server, off);
  };
  return (
    // Two lines always: the CLI, then where it's set up or what's wrong; a dot on the CLI's mark when something's off.
    <div className="relative flex h-14 items-center gap-2.5 border-t border-hairline first:border-t-0">
      <span className={`relative ml-1 flex shrink-0 ${isOff(server) ? "opacity-45 grayscale" : ""}`}>
        <ProviderIcon provider={server.provider} className="size-4" />
        {status.problem && <span className="absolute -right-[3px] -bottom-[3px] size-2 rounded-full bg-warning ring-2 ring-card" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col" title={server.error ?? undefined}>
        <span className={`font-medium ${isOff(server) ? "text-text-muted" : ""}`}>{cli}</span>
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] text-text-muted`}>
          <span className={`truncate ${status.working ? "crew-shimmer" : ""}`}>{status.text}</span>
        </span>
      </span>
      {fix && !status.working && <RowAction label={fix.label} onClick={fix.run} />}
      {busy !== "removing" && <RowMenu label={`More for ${cli}`} actions={menu} onPick={pick} />}
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
