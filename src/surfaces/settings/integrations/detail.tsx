// A connector's own page, or a provider server's (the strip above says
// Connectors › Linear). It keeps the connectors' width, so the page doesn't
// jump and back stays where it was. What's wrong sits on the row it's about
// (an account, a CLI's copy), with its fix there. Each account says how many
// workspaces it's for, changed from its ⋯; below them, which of its tools a
// session gets, with pills to pick the account when there are several. A server's page has
// its copy in each CLI on its machine.
// Escape and the arrow above the mark go back to the connectors.
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { EnvGlyph } from "../../../chrome/EnvBits";
import { Card, IconButton } from "../../../chrome/kit";
import { useEnvLinks } from "../../../hooks/useEnvLinks";
import { LOCAL } from "../../../lib/client/registry";
import type { ConnectorTool } from "../../../lib/protocol";
import { Group, Row, SettingsPage } from "../ui";
import { Pills, RowAction, SwitchRow } from "./bits";
import { CliRow, ServerMark } from "./clis";
import { hostOf, startAddAccount, ui, useEscape, useUi, type Detail } from "./lib";
import { AccountRow } from "./manage";
import { brandOf } from "./brand";
import { ServiceMark } from "./mark";
import { OutsideGroup } from "./outside";
import { UnofficialNote, vendorOf } from "./builtin";
import { useProviderServers } from "./providers";
import { groupsOf, providerName, serverLine } from "./servers";
import { actions, builtinOf, cancelFlow, connectorOf, flowLine, formatTokens, useIntegrations, waitsInBrowser, type Account } from "./store";

const home = () => ui.go("home");
/** Figma's registry name: it signs Crew in under an approved client's name (`oauth::client_name`). */
const FIGMA = "com.figma.mcp/mcp";
const noop = () => {};

export function DetailPage({ detail }: { detail: Detail }) {
  const { sheet } = useUi();
  useEscape(sheet ? noop : home);
  return detail.kind === "connector" ? <ConnectorPage connectorId={detail.id} /> : <ServerPage envId={detail.envId} groupKey={detail.key} />;
}

/** Back above, then mark, name and one line lined up with the page's edge; removing it all is the trash at the end. */
function Header({ mark, title, subtitle, action }: { mark: ReactNode; title: string; subtitle: string; action?: ReactNode }) {
  return (
    <header className="-mt-6 flex flex-col gap-3 px-1">
      <IconButton icon={ArrowLeftIcon} label="Back to Connectors" className="-ml-2 size-8 self-start" onClick={home} />
      <div className="flex items-center gap-3">
        {mark}
        <div className="flex min-w-0 flex-1 flex-col pr-6">
          <h1 className="truncate text-[22px] leading-7 font-semibold tracking-[-0.02em]">{title}</h1>
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
                ? `Signs out every account here, except at ${vendorOf(builtin.family)} for its other apps. Can’t be undone.`
                : "Signs out every account at the service. Can’t be undone.",
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
      {!builtin && <OutsideGroup connector={connector} />}
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
          <Row label="Signs in as" description="Figma lets only approved clients sign in; Crew registers as one">
            <span className="text-text-muted">Claude Code</span>
          </Row>
        )}
      </Group>
      {builtin && <UnofficialNote vendor={vendorOf(builtin.family)} />}
    </SettingsPage>
  );
}

/* ── One provider server ────────────────────────────────────────────── */

/** The machine's copies, titled by the machine with its glyph: a laptop for this Mac, a server for a remote box. */
function MachineGroup({ envId, children }: { envId: string; children: ReactNode }) {
  const link = useEnvLinks().find((l) => l.id === envId);
  // This Mac's daemon is the window's own; only a remote is ever away.
  const online = !link || link.id === LOCAL || link.status === "online";
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex min-h-6 items-center gap-1.5 px-2.5 text-[12px] font-medium text-text-muted">
        <EnvGlyph link={link ?? null} className="size-3.5" />
        {link ? (online ? link.name : `${link.name} · offline`) : envId}
      </h2>
      <Card>{children}</Card>
    </section>
  );
}

function ServerPage({ envId, groupKey }: { envId: string; groupKey: string }) {
  const m = useProviderServers(envId);
  const group = groupsOf(m.inventory, m.registryOf).find((g) => g.key === groupKey);
  // Gone from every CLI (here, or from elsewhere), there's nothing left to show.
  // A registry key only finds its group once the registry has answered.
  const gone = m.settled && !group;
  useEffect(() => {
    if (gone) home();
  }, [gone]);
  if (!group) return null;
  const first = group.servers[0]!;
  // Where it runs, once when every copy says the same, else per CLI.
  const targets = [...new Set(group.servers.map((x) => x.target).filter(Boolean))];
  const remote = /^https?:\/\//.test(first.target);
  return (
    <SettingsPage title={group.name} hideHeader>
      <Header mark={<ServerMark server={first} registry={group.registry} size={40} />} title={group.name} subtitle={serverLine(first)} />
      <MachineGroup envId={envId}>
        {group.servers.map((server) => (
          <CliRow key={server.provider} envId={envId} server={server} m={m} />
        ))}
      </MachineGroup>
      {targets.length > 0 && (
        <Group title="About">
          {targets.length === 1 ? (
            <Row label={remote ? "Server" : "Command"} description={<Target text={first.target} />} />
          ) : (
            group.servers
              .filter((x) => x.target)
              .map((server) => <Row key={server.provider} label={providerName(server.provider)} description={<Target text={server.target} />} />)
          )}
        </Group>
      )}
    </SettingsPage>
  );
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
        <Row label={<span className="text-text-muted">{account.state === "connected" ? "The server lists no tools." : "Its tools show once it’s signed in."}</span>} />
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
