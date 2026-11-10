// A connector's own page, or a provider server's (the strip above says
// Connectors › Linear). It keeps the connectors' width, so the page doesn't
// jump and back stays where it was. What's wrong sits on the row it's about
// (an account, a CLI's copy), with its fix there. Each account says how many
// workspaces it's for, changed from its ⋯; below them, which of its tools a
// session gets, with pills to pick the account when there are several. A server's page has
// one switch for Crew on every machine beside its name, then a row per machine it's installed on.
// Escape and the arrow above the mark go back to the connectors.
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { BackLink, IconButton, PAGE_TITLE, Switch } from "../../../chrome/kit";
import { LOCAL } from "../../../lib/client/registry";
import type { ConnectorTool } from "../../../lib/protocol";
import { Group, Row, SettingsPage } from "../ui";
import { Pills, RowAction, SwitchRow } from "./bits";
import { MachineRow, ServerMark } from "./clis";
import { hostOf, startAddAccount, ui, useEscape, useUi, type Detail } from "./lib";
import { AccountRow } from "./manage";
import { brandOf } from "./brand";
import { ServiceMark } from "./mark";
import { UnofficialNote, vendorOf } from "./builtin";
import { machineName, setServiceOn, useMachines, useServices } from "./providers";
import { copiesPhrase, perSpawn, providerName, serverLine, serviceOn } from "./servers";
import { actions, builtinOf, cancelFlow, connectorOf, flowLine, formatTokens, useIntegrations, waitsInBrowser, type Account } from "./store";

const home = () => ui.go("home");
/** Figma's registry name: it signs Crew in under an approved client's name (`oauth::client_name`). */
const FIGMA = "com.figma.mcp/mcp";
const noop = () => {};

export function DetailPage({ detail }: { detail: Detail }) {
  const { sheet } = useUi();
  useEscape(sheet ? noop : home);
  return detail.kind === "connector" ? <ConnectorPage connectorId={detail.id} /> : <ServerPage groupKey={detail.key} />;
}

/** Back above, then mark, name and one line lined up with the page's edge; removing it all is the trash at the end. */
function Header({ mark, title, subtitle, action }: { mark: ReactNode; title: string; subtitle: string; action?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4">
      <BackLink onClick={home} />
      <div className="flex items-center gap-3 px-1">
        {mark}
        <div className="flex min-w-0 flex-1 flex-col pr-6">
          <h1 className={`truncate ${PAGE_TITLE}`}>{title}</h1>
          <p className="line-clamp-2 text-[13px] text-pretty text-text-muted" title={subtitle}>
            {subtitle}
          </p>
        </div>
        {action}
      </div>
    </header>
  );
}

/** The header's trash, asked once more in a confirmation. */
function RemoveButton({ label, confirm: ask }: { label: string; confirm: Confirm }) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  return (
    <>
      <IconButton icon={Trash2Icon} label={label} className="size-8" onClick={() => setConfirm(ask)} />
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function ConnectorPage({ connectorId }: { connectorId: string }) {
  const s = useIntegrations();
  const connector = connectorOf(s, connectorId);
  const accounts = connector?.accounts ?? [];
  const adding = s.flows.filter(
    (f) => f.connectorId === connectorId && f.stage !== "done" && f.stage !== "failed" && !accounts.some((a) => a.id === f.accountId),
  );
  const [picked, setPicked] = useState<string | null>(null);
  // Removed (here, or from elsewhere), there's nothing left to show.
  const gone = s.loaded && !connector;
  useEffect(() => {
    if (gone) home();
  }, [gone]);
  if (!connector) return null;
  const account = accounts.find((a) => a.id === picked) ?? accounts[0];
  const builtin = builtinOf(s, connector);
  // Its workspaces first, when there are several; then a built-in asks which account when its siblings have one.
  const addAccount = () => (s.workspaces.length > 1 ? ui.open({ kind: "add-account", connectorId }) : startAddAccount(s, connectorId, null));
  return (
    <SettingsPage title={connector.name} hideHeader>
      <Header
        mark={<ServiceMark brand={brandOf(connector)} size={40} />}
        title={connector.name}
        subtitle={connector.description || connector.publisher}
        action={
          <RemoveButton
            label={`Remove ${connector.name}`}
            confirm={{
              title: `Remove ${connector.name}?`,
              description: builtin
                ? `Signs out all accounts. Your other ${vendorOf(builtin.family)} apps stay connected.`
                : "Signs out all accounts.",
              action: "Remove",
              onConfirm: () => actions.removeConnector(connector.id),
            }}
          />
        }
      />
      <Group title="Accounts">
        {accounts.map((a) => (
          <AccountRow key={a.id} account={a} />
        ))}
        {adding.map((flow) => (
          <div key={flow.id} className="flex h-14 items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">New account</span>
              <span className="crew-shimmer self-start text-[12px]">{flowLine(flow)}</span>
            </div>
            {waitsInBrowser(flow) && <RowAction label="Cancel" onClick={() => cancelFlow(flow.id)} />}
          </div>
        ))}
        {/* Its workspaces, then the sign-in, private so the account already signed in doesn't answer. */}
        <button
          type="button"
          disabled={adding.length > 0}
          onClick={addAccount}
          className="flex h-12 w-full items-center gap-1.5 text-left text-text-muted outline-none transition-colors hover:text-text focus-visible:text-text disabled:opacity-50 disabled:hover:text-text-muted"
        >
          <PlusIcon className="size-4" />
          {accounts.length === 0 ? "Add an account" : "Add another account"}
        </button>
      </Group>
      {account && (
        <>
          {accounts.length > 1 && (
            <Pills
              small
              label="Account"
              value={account.id}
              onChange={setPicked}
              className="-mb-3 self-start"
              options={accounts.map((a) => ({ value: a.id, label: a.label }))}
            />
          )}
          <ToolsGroup account={account} />
        </>
      )}
      <Group title="About">
        <Row label="Publisher">
          <span className="text-text-muted">{connector.publisher}</span>
        </Row>
        <Row label="Server">
          <span className="truncate text-text-muted" title={connector.url}>
            {builtin ? builtin.server : hostOf(connector.url) || connector.url}
          </span>
        </Row>
        {connector.registryName && (
          <Row label="Registry">
            <span className="text-text-muted">{connector.registryName}</span>
          </Row>
        )}
        {connector.registryName === FIGMA && (
          <Row label="Signs in as" description="Figma only allows approved apps, so Crew signs in as Claude Code.">
            <span className="text-text-muted">Claude Code</span>
          </Row>
        )}
      </Group>
      {builtin && <UnofficialNote vendor={vendorOf(builtin.family)} />}
    </SettingsPage>
  );
}

/* ── One provider server ────────────────────────────────────────────── */

/**
 * A provider server's page: one switch for Crew on every machine beside its
 * name, then where it's installed, a row per machine with the CLIs that have it there.
 */
function ServerPage({ groupKey }: { groupKey: string }) {
  const { links, ids } = useMachines();
  const v = useServices(ids);
  const service = v.services.find((g) => g.key === groupKey);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // Gone from every CLI on every machine (here, or from elsewhere), there's nothing left to show.
  // A registry key only finds its service once the registry has answered.
  const gone = v.settled && !service;
  useEffect(() => {
    if (gone) home();
  }, [gone]);
  if (!service) return null;
  const first = service.servers[0]!;
  const on = serviceOn(service, v.choices);
  // Cursor and Grok have no per-session way to leave a server out: off in Crew writes their own config.
  const outside = service.machines.flatMap((m) =>
    m.servers
      .filter((x) => !perSpawn(x.provider) && !x.offInCrew)
      .map((x) => ({ cli: providerName(x.provider), machine: m.envId === LOCAL ? "this Mac" : machineName(links.find((l) => l.id === m.envId), m.envId) })),
  );
  const toggle = (next: boolean) => {
    if (next || outside.length === 0) return setServiceOn(service.key, next);
    setConfirm({
      title: `Disable ${service.name}?`,
      description: `Turns it off in ${copiesPhrase(outside)}.`,
      action: "Disable",
      onConfirm: () => setServiceOn(service.key, false),
    });
  };
  const several = service.machines.length > 1;
  // Where it runs, once when every copy says the same, else per CLI.
  const targets = [...new Set(service.servers.map((x) => x.target).filter(Boolean))];
  const remote = /^https?:\/\//.test(first.target);
  return (
    <SettingsPage title={service.name} hideHeader>
      <Header
        mark={<ServerMark server={first} registry={service.registry} size={40} />}
        title={service.name}
        subtitle={on ? serverLine(first) : `Off in Crew${several ? " on every machine" : ""} · ${serverLine(first)}`}
        action={<Switch label={`Use ${service.name} in Crew`} checked={on} onChange={toggle} />}
      />
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
      <Group title="Installed on">
        {service.machines.map((m) => (
          <MachineRow key={m.envId} envId={m.envId} title={service.name} servers={m.servers} busy={(server) => v.busy(m.envId, server)} />
        ))}
      </Group>
      {targets.length > 0 && (
        <Group title="About">
          {targets.length === 1 ? (
            <Row label={remote ? "Server" : "Command"} description={<Target text={first.target} />} />
          ) : (
            uniqueBy(service.servers.filter((x) => x.target), (x) => `${x.provider}\u0000${x.target}`).map((server) => (
              <Row key={`${server.provider}:${server.target}`} label={providerName(server.provider)} description={<Target text={server.target} />} />
            ))
          )}
        </Group>
      )}
    </SettingsPage>
  );
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A URL or a command line under its label, wrapping wherever it must: a long one is read whole, not cut. */
function Target({ text }: { text: string }) {
  return <span className="mt-0.5 block font-mono text-[12px] break-all text-text-muted select-text">{text}</span>;
}

/* ── Tools ──────────────────────────────────────────────────────────── */

/** What the tools on cost every session's context, and a switch each; one that's off is left out of the list. */
function ToolsGroup({ account }: { account: Account }) {
  if (account.tools.length === 0) {
    return (
      <Group title="Tools">
        <Row label={<span className="text-text-muted">{account.state === "connected" ? "No tools available." : "Sign in to see its tools."}</span>} />
      </Group>
    );
  }
  const tokens = account.tools.filter((t) => !account.toolsOff.includes(t.name)).reduce((n, t) => n + t.tokens, 0);
  return (
    <Group title="Tools" action={<span className="text-[12px] text-text-muted tabular-nums">{formatTokens(tokens)} tokens</span>}>
      {account.tools.map((tool) => (
        <SwitchRow
          key={tool.name}
          label={tool.name}
          description={toolLine(tool)}
          checked={!account.toolsOff.includes(tool.name)}
          onChange={(next) => actions.setTool(account.id, tool.name, next)}
        />
      ))}
    </Group>
  );
}

/** The server's words, cut to their first sentence and without its full stop. */
function toolLine(tool: ConnectorTool): string | undefined {
  const words = (tool.title ?? tool.description).split("\n")[0]?.trim() ?? "";
  const first = (words.split(/(?<=[.!?])\s/)[0] ?? "").replace(/\.$/, "");
  return first ? (first.length > 140 ? `${first.slice(0, 139)}…` : first) : undefined;
}
