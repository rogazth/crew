// MOCKUP, not wired to the daemon: a connector added to a CLI's own config,
// for use outside Crew. Crew's sessions already get the connector through the
// vault; a copy in a CLI is the CLI's server, signed in on its own, on one
// machine. It is offered in two places: a registry server's summary in Browse
// (beside Install, and in its place when the server refuses Crew's sign-in),
// and a connector's page, which lists the copies under "Outside Crew". A copy
// is keyed by the server's URL, so one added from Browse shows on the page
// once the connector is installed. State lives in memory here and every step
// is a timer.
import { CheckIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { EnvGlyph } from "../../../chrome/EnvBits";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { Button, Switch } from "../../../chrome/kit";
import { useEnvLinks } from "../../../hooks/useEnvLinks";
import { LOCAL } from "../../../lib/client/registry";
import { Group } from "../ui";
import { Pills, RowAction, RowMenu } from "./bits";
import { Dialog, DialogBody, DialogFooter, DialogGroup, DialogHeader, DialogRow } from "./dialog";
import { brandOf, brandOfServer, type Brand } from "./brand";
import { ui } from "./lib";
import { ServiceMark } from "./mark";
import { PROVIDER_ORDER, listJoin, providerName } from "./servers";
import type { Connector, RegistryServer } from "../../../lib/protocol";
import { connectorOf, useIntegrations } from "./store";
import { CONFIG, installed, mock, same, useCopies, type Copy, type CopyState } from "./copies";

const STATE_LINE: Record<CopyState, string> = {
  adding: "Adding to its config…",
  "needs-auth": "Needs sign-in",
  "signing-in": "Waiting for the browser…",
  connected: "Signed in",
};

/* ── The page's group ───────────────────────────────────────────────── */

/** Below the tools: the connector's copies in the providers' own configs, by machine, and the way to add one. */
export function OutsideGroup({ connector }: { connector: Connector }) {
  const all = useCopies().filter((c) => c.url === connector.url);
  const links = useEnvLinks();
  const rank = (c: Copy) => PROVIDER_ORDER.indexOf(c.provider);
  const ordered = [...all].sort((a, b) => (a.envId === b.envId ? rank(a) - rank(b) : a.envId === LOCAL ? -1 : b.envId === LOCAL ? 1 : a.envId.localeCompare(b.envId)));
  return (
    <Group
      title="Outside Crew"
      description={`Crew’s sessions already get ${connector.name}. Add it to a provider to use it there on its own; the provider signs in again and keeps its own credential.`}
    >
      {ordered.map((copy) => (
        <CopyRow key={`${copy.envId}:${copy.provider}`} copy={copy} machine={links.find((l) => l.id === copy.envId)?.name ?? "This Mac"} name={connector.name} />
      ))}
      <button
        type="button"
        onClick={() => ui.open({ kind: "cli", target: { connectorId: connector.id } })}
        className="flex h-12 w-full items-center gap-1.5 text-left text-text-muted outline-none transition-colors hover:text-text focus-visible:text-text"
      >
        <PlusIcon className="size-4" />
        Add to providers…
      </button>
    </Group>
  );
}

function CopyRow({ copy, machine, name }: { copy: Copy; machine: string; name: string }) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const cli = providerName(copy.provider);
  const working = copy.state === "adding" || copy.state === "signing-in";
  const tone = copy.state === "needs-auth" ? "text-warning" : "text-text-muted";
  return (
    <div className="flex h-14 items-center gap-2.5 border-t border-hairline first:border-t-0">
      <span className="relative ml-1 flex shrink-0">
        <ProviderIcon provider={copy.provider} className="size-4" />
        {copy.state === "needs-auth" && <span className="absolute -right-[3px] -bottom-[3px] size-2 rounded-full bg-warning ring-2 ring-card" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          {cli} <span className="font-normal text-text-muted">on {machine}</span>
        </span>
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${tone}`}>
          <span className={`truncate ${working ? "crew-shimmer" : ""}`}>
            {STATE_LINE[copy.state]}
            {!working && <span className="text-text-muted"> · {CONFIG[copy.provider]}</span>}
          </span>
        </span>
      </span>
      {copy.state === "needs-auth" && <RowAction label="Authenticate" onClick={() => mock.signIn(copy)} />}
      {copy.state !== "adding" && (
        <RowMenu
          label={`More for ${cli}`}
          actions={[{ id: "remove", label: "Remove", icon: "delete", danger: true }]}
          onPick={() =>
            setConfirm({
              title: `Remove ${name} from ${cli}?`,
              description: `This deletes it from ${cli}’s config on ${machine}. Crew’s sessions keep it.`,
              action: "Remove",
              onConfirm: () => mock.remove(copy),
            })
          }
        />
      )}
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/* ── The sheet ──────────────────────────────────────────────────────── */

/** What the sheet adds: an installed connector, or a registry server from Browse, which Cancel goes back to. */
export type CliTarget = { connectorId: string } | { server: RegistryServer };

/** Pick a machine, then the providers; one that already has it, or isn't on that machine, says so instead of a switch. */
export function AddToCliDialog({ target }: { target: CliTarget }) {
  const s = useIntegrations();
  const connector = "connectorId" in target ? connectorOf(s, target.connectorId) : undefined;
  const subject: { brand: Brand; url: string } | null =
    "server" in target ? { brand: brandOfServer(target.server), url: target.server.remoteUrl } : connector ? { brand: brandOf(connector), url: connector.url } : null;
  const cancel = () => ("server" in target ? ui.open({ kind: "summary", server: target.server }) : ui.close());
  const links = useEnvLinks();
  const all = useCopies();
  const [envId, setEnvId] = useState<string>(links[0]?.id ?? LOCAL);
  const [picked, setPicked] = useState<string[]>(["claude"]);
  const [sent, setSent] = useState<string[] | null>(null);
  if (!subject) return null;
  const { brand, url } = subject;
  const machine = links.find((l) => l.id === envId);
  const machineName = machine?.name ?? "This Mac";
  const has = (provider: string) => all.some((c) => same(c, { url, envId, provider }));
  const choosable = (provider: string) => installed(envId, provider) && !has(provider);
  const chosen = picked.filter(choosable);
  const toggle = (provider: string, on: boolean) => setPicked((p) => (on ? [...p, provider] : p.filter((x) => x !== provider)));
  const add = () => {
    mock.add(url, envId, chosen);
    setSent(chosen);
  };
  const title = `Add ${brand.name} to providers`;

  if (sent) {
    const mine = all.filter((c) => c.url === url && c.envId === envId && sent.includes(c.provider));
    const done = mine.every((c) => c.state !== "adding");
    return (
      <Dialog label={title}>
        <DialogHeader mark={<ServiceMark brand={brand} size={40} />} title={done ? `Added to ${listJoin(sent.map(providerName))}` : title} subtitle={`On ${machineName}`} />
        <DialogGroup>
          {mine.map((c) => (
            <DialogRow
              key={c.provider}
              icon={<ProviderIcon provider={c.provider} className="size-4" />}
              title={providerName(c.provider)}
              subtitle={c.state === "adding" ? <span className="crew-shimmer">Writing its config…</span> : `In ${CONFIG[c.provider]} · sign in from its row`}
            >
              {c.state !== "adding" && <CheckIcon className="size-4 text-success" />}
            </DialogRow>
          ))}
        </DialogGroup>
        <DialogFooter>
          <Button variant="primary" disabled={!done} onClick={ui.close}>
            Done
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog label={title}>
      <DialogHeader mark={<ServiceMark brand={brand} size={40} />} title={title} subtitle="For using it outside Crew" />
      <DialogBody>
      {links.length > 1 && (
        <div className="px-4 pb-4">
          <Pills
            small
            label="Machine"
            value={envId}
            onChange={setEnvId}
            options={links.map((l) => ({ value: l.id, label: l.name, icon: <EnvGlyph link={l} className="size-3.5" /> }))}
          />
        </div>
      )}
      <DialogGroup title={`Providers on ${machineName}`}>
        {PROVIDER_ORDER.map((provider) => {
          const here = installed(envId, provider);
          const already = has(provider);
          return (
            <DialogRow
              key={provider}
              icon={<ProviderIcon provider={provider} className={`size-4 ${here ? "" : "opacity-45 grayscale"}`} />}
              title={<span className={here ? "" : "text-text-muted"}>{providerName(provider)}</span>}
              subtitle={!here ? `Not installed on ${machineName}` : already ? "Already has it" : CONFIG[provider]}
            >
              {here && !already && <Switch label={providerName(provider)} checked={picked.includes(provider)} onChange={(on) => toggle(provider, on)} />}
              {already && <CheckIcon className="size-4 text-text-muted" />}
            </DialogRow>
          );
        })}
      </DialogGroup>
      <p className="-mt-2 px-5 pb-4 text-[12px] text-text-muted">
        Writes only the server URL to each provider’s config, never a token. Each signs in on its own.
      </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={cancel}>
          {"server" in target ? "Back" : "Cancel"}
        </Button>
        <Button variant="primary" disabled={chosen.length === 0} onClick={add}>
          {chosen.length > 1 ? `Add to ${chosen.length} providers` : "Add"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Browse's way in, a row in a server's summary: the providers' marks, what it's for, and Add. */
export function ProvidersRow({ server }: { server: RegistryServer }) {
  return (
    <DialogGroup>
      <DialogRow
        icon={
          <span className="flex shrink-0 -space-x-1">
            {PROVIDER_ORDER.slice(0, 3).map((provider) => (
              <span key={provider} className="grid size-5 place-items-center rounded-full bg-surface ring-2 ring-card">
                <ProviderIcon provider={provider} className="size-3" />
              </span>
            ))}
          </span>
        }
        title="Your providers"
        subtitle="Also use it in Claude Code, Codex and others outside Crew"
      >
        <RowAction label="Add…" onClick={() => ui.open({ kind: "cli", target: { server } })} />
      </DialogRow>
    </DialogGroup>
  );
}
