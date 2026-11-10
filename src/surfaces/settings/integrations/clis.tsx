// "From your providers": the servers each CLI has set up, on every machine,
// one chip per server however many CLIs and machines have it: its mark, its
// name, and a dot when something's off. A click opens its page (detail.tsx),
// with its copies on each machine. Whether it's on in Crew is one switch for
// every machine (providers.ts keeps it); calls about one copy go to that
// copy's machine.
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { EnvGlyph } from "../../../chrome/EnvBits";
import { useEnvStates } from "../../../hooks/useEnvLinks";
import { LOCAL } from "../../../lib/client/registry";
import type { MenuAction } from "../../../lib/menu";
import { RowAction, RowMenu } from "./bits";
import { TONE_BG, openServer } from "./lib";
import { ServiceMark } from "./mark";
import { machineLive, machineName, serverActions, useMachines, useServices, type ServicesView } from "./providers";
import { TileSection } from "./sections";
import type { RegistryServer } from "../../../lib/protocol";
import { brandOfServer, displayName, isOff, listJoin, offlinePhrase, providerName, rowStatus, serviceOn, serviceStatus, type Busy, type Server, type Service } from "./servers";

/** A server's mark: the registry's, else its host's favicon, else its name's monogram. */
export function ServerMark({ server, size, registry }: { server: Server; size: number; registry?: RegistryServer | undefined }) {
  // A local command has no host to draw a mark from: its name's monogram, never its CLI's mark.
  const brand = brandOfServer(server, registry) ?? { id: displayName(server), name: displayName(server), publisher: "", logo: null };
  return <ServiceMark brand={brand} size={size} />;
}

export function FromProviders() {
  const { links, ids } = useMachines();
  const v = useServices(ids);
  // Nothing until every machine's servers are named, so chips don't merge in front of the person.
  const services = v.settled ? v.services : [];
  const name = (envId: string) => machineName(links.find((l) => l.id === envId), envId);
  const away = ids.filter((envId) => !machineLive(links.find((l) => l.id === envId), envId) && (v.machines[envId]?.inventory.length ?? 0) > 0);
  const failed = ids.filter((envId) => machineLive(links.find((l) => l.id === envId), envId) && v.machines[envId]?.error);
  return (
    <div className="flex flex-col gap-2">
      <TileSection title="From your providers" count={services.length > 0 ? services.length : undefined} layout="chips" fold={Infinity}>
        {services.map((service) => (
          <ProviderChip key={service.key} service={service} v={v} />
        ))}
      </TileSection>
      {away.length > 0 && (
        <p className="px-1 text-[12px] text-text-muted">
          {offlinePhrase(away.map(name))}
        </p>
      )}
      {failed.map((envId) => (
        <p key={envId} className="px-1 text-[12px] text-danger">
          Couldn’t read the servers on {name(envId)}: {v.machines[envId]?.error}
        </p>
      ))}
    </div>
  );
}

/** One server as a chip: its mark and its name, and a dot only when something's off. The rest is on its page. */
function ProviderChip({ service, v }: { service: Service; v: ServicesView }) {
  const status = serviceStatus(service, v.busy);
  const on = serviceOn(service, v.choices);
  return (
    <button
      type="button"
      title={on ? status.text : "Off in Crew"}
      onClick={() => openServer(service.key, service.name)}
      className="relative flex h-11 min-w-0 items-center gap-2.5 rounded-lg bg-card px-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <span className={`relative shrink-0 ${on ? "" : "opacity-45 grayscale"}`}>
        <ServerMark server={service.servers[0]!} registry={service.registry} size={22} />
        {on && (status.tone === "warning" || status.tone === "danger") && <span className={`absolute -right-[2px] -bottom-[2px] size-2 rounded-full ring-2 ring-canvas ${TONE_BG[status.tone]}`} />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? "" : "text-text-muted line-through decoration-text-muted/50"}`}>{service.name}</span>
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
 * One machine that has the server: its name, then the CLIs that have it, or
 * the first copy that needs something, with that copy's one fix. Removing it
 * from the machine (every CLI there) is behind ⋯; turning it on or off is the
 * service's one switch, for every machine.
 */
export function MachineRow({ envId, title, servers, busy }: { envId: string; title: string; servers: Server[]; busy: (server: Server) => Busy }) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const link = useEnvStates().find((l) => l.id === envId);
  const name = machineName(link, envId);
  const online = machineLive(link, envId);
  const here = envId === LOCAL ? "this Mac" : name;
  const rows = servers.map((server) => ({ server, status: rowStatus(server, busy(server)) }));
  // What this machine says: a copy at work, else one that needs the person, else its CLIs.
  const speaking = rows.find((r) => r.status.working) ?? rows.find((r) => r.status.problem);
  const clis = listJoin(servers.map((x) => providerName(x.provider)));
  const allOff = servers.every(isOff);
  const line = speaking ? `${providerName(speaking.server.provider)}: ${speaking.status.text}` : allOff ? `Off · ${clis}` : clis;
  const fixing = rows.find((r) => r.status.fix && !r.status.working);
  const fix =
    fixing?.status.fix === "sign-in"
      ? { label: "Sign in", run: () => serverActions.signIn(envId, fixing.server) }
      : fixing?.status.fix === "claude.ai"
        ? { label: "Open claude.ai", run: serverActions.openClaudeAi }
        : fixing?.status.fix === "retry"
          ? { label: "Try now", run: () => serverActions.retry(envId, fixing.server) }
          : null;
  // One Remove for the machine: every copy its CLIs let Crew take out; the rest stay, and the confirmation says why.
  const removable = servers.filter((x) => x.canRemove);
  const kept = servers.filter((x) => !x.canRemove);
  const removing = servers.some((x) => busy(x) === "removing");
  const menu: Omit<MenuAction, "hotkey">[] = [
    {
      id: "remove",
      label: "Remove",
      icon: "delete",
      danger: removable.length > 0,
      disabled: removable.length === 0 || removing,
      ...(removable.length === 0 ? { hint: removeHint(servers[0]!, providerName(servers[0]!.provider)) } : {}),
    },
  ];
  const pick = () => {
    const from = listJoin(removable.map((x) => providerName(x.provider)));
    const stays = kept.length > 0 ? ` ${listJoin(kept.map((x) => providerName(x.provider)))} ${kept.length === 1 ? "keeps" : "keep"} it.` : "";
    setConfirm({
      title: `Remove ${title}?`,
      description: `Removes it from ${from} on ${here}.${stays}`,
      action: "Remove",
      onConfirm: () => removable.forEach((server) => serverActions.remove(envId, server)),
    });
  };
  return (
    // Two lines always: the machine, then its CLIs or what's wrong; a dot on its glyph when something's off.
    <div className="relative flex h-14 items-center gap-2.5 border-t border-hairline first:border-t-0">
      <span className={`relative ml-1 flex shrink-0 ${allOff ? "opacity-45" : ""}`}>
        <EnvGlyph link={link ?? null} className="size-4" />
        {!allOff && rows.some((r) => r.status.problem) && <span className="absolute -right-[3px] -bottom-[3px] size-2 rounded-full bg-warning ring-2 ring-card" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col" title={speaking?.server.error ?? undefined}>
        <span className={`font-medium ${allOff ? "text-text-muted" : ""}`}>{online ? name : `${name} · offline`}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-muted">
          <span className={`truncate ${speaking?.status.working ? "crew-shimmer" : ""}`}>{line}</span>
        </span>
      </span>
      {fix && online && <RowAction label={fix.label} onClick={fix.run} />}
      <RowMenu label={`More for ${name}`} actions={menu} onPick={pick} />
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
