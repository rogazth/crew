// PROTOTYPE — throwaway. A connector's own page: one of Crew's connectors, or
// one provider server (the strip above says Connectors › Linear). It keeps the
// connectors' width, so the page doesn't jump and back stays where it was.
// What's wrong sits on the row it's about (an account, a CLI's copy), with its
// fix there; only a cause shared by every row, the vault, is a notice on top.
// Escape and the arrow above the mark go back to the connectors.
import { AlertCircleIcon, ArrowLeftIcon, ArrowUpRightIcon, LoaderCircleIcon, PauseCircleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { Button, Card, IconButton } from "../../../chrome/kit";
import { Callout, Group, Row, SettingsPage } from "../ui";
import { MachineGlyph, ServiceMark } from "./parts.prototype";
import { CliRow, ServerMark, groupsOf, uniq } from "./VariantC.clis.prototype";
import { plural, ui, useEscape, useUi, type Detail } from "./VariantC.lib.prototype";
import { AccountRow } from "./VariantC.manage.prototype";
import { actions, formatTokens, machineOf, serviceOf, useIntegrations, type Machine, type State } from "./store.prototype";

const home = () => ui.go("home");
const noop = () => {};

/** The trail's last crumb: the connector's or the server's name. */
export function detailName(s: State, detail: Detail): string {
  if (detail.kind === "connector") return serviceOf(detail.serviceId)?.name ?? "Connector";
  return groupsOf(s).find((g) => g.key === detail.key)?.name ?? "Server";
}

export function DetailPage({ detail }: { detail: Detail }) {
  const { sheet } = useUi();
  useEscape(sheet ? noop : home);
  return detail.kind === "connector" ? <ConnectorPage serviceId={detail.serviceId} /> : <ServerPage groupKey={detail.key} />;
}

/** Back above, then mark, name and one line lined up with the page's edge; removing it all is the trash at the end. */
function Header({ mark, title, subtitle, action }: { mark: ReactNode; title: string; subtitle: string; action?: ReactNode }) {
  return (
    <header className="-mt-6 flex flex-col gap-3 px-1">
      <IconButton icon={ArrowLeftIcon} label="Back to Connectors" className="-ml-2 size-8 self-start" onClick={home} />
      <div className="flex items-center gap-3">
        {mark}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-[22px] leading-7 font-semibold tracking-[-0.02em]">{title}</h1>
          <p className="truncate text-[13px] text-text-muted">{subtitle}</p>
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

const fixButton = (label: string, run: () => void) => (
  <Button variant="primary" className="h-7 px-2.5 text-[12px]" onClick={run}>
    {label}
  </Button>
);

/* ── One of Crew's connectors ───────────────────────────────────────── */

function ConnectorPage({ serviceId }: { serviceId: string }) {
  const s = useIntegrations();
  const service = serviceOf(serviceId);
  const accounts = s.accounts.filter((a) => a.serviceId === serviceId);
  const adding = s.flows.filter((f) => f.kind === "account" && f.serviceId === serviceId && f.stage !== "done" && f.stage !== "failed" && !accounts.some((a) => a.id === f.target));
  // The last account removed, there's nothing left to show.
  const gone = !service || (accounts.length === 0 && adding.length === 0);
  useEffect(() => {
    if (gone) home();
  }, [gone]);
  if (gone) return null;
  const vault = machineOf(s, s.vault.machine);
  const lease = s.vault.lessees.find((l) => l.machine === "local")?.leaseMinutes ?? 0;
  const paused = accounts.some((a) => a.state === "vault-offline");
  const ending = !paused && accounts.some((a) => a.state === "lease-ending");
  return (
    <SettingsPage title={service.name} hideHeader>
      <Header
        mark={<ServiceMark service={service} size={40} />}
        title={service.name}
        subtitle={service.publisher}
        action={
          <RemoveButton
            label={`Remove ${service.name}`}
            confirm={{
              title: `Remove ${service.name}?`,
              description: "This action can’t be undone.",
              action: "Remove",
              onConfirm: () => accounts.forEach((a) => actions.disconnect(a.id)),
            }}
          />
        }
      />
      {/* The vault is every account's cause at once, so it's one notice; an account's own trouble is on its row. */}
      {(paused || ending) && (
        <div className="flex flex-col gap-2">
          {paused && (
            <Callout
              tone="warning"
              icon={PauseCircleIcon}
              title="Paused while the vault is offline"
              description={`Sign-ins are kept on ${vault.name}. Sessions start without these tools until it’s back.`}
              action={fixButton("Open vault", () => ui.open({ kind: "vault" }))}
            />
          )}
          {ending && (
            <Callout
              tone="warning"
              icon={AlertCircleIcon}
              title={`Stops in ${lease} min`}
              description={`The vault on ${vault.name} is offline, and this Mac’s lease on the sign-in runs out.`}
              action={fixButton("Open vault", () => ui.open({ kind: "vault" }))}
            />
          )}
        </div>
      )}
      <Group title="Accounts">
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
        {adding.map((flow) => (
          <div key={flow.id} className="flex h-14 flex-col justify-center">
            <span className="font-medium">New account</span>
            <span className="flex items-center gap-1 text-[12px] text-info">
              <LoaderCircleIcon className="size-3 animate-spin" />
              Authenticating…
            </span>
          </div>
        ))}
        {/* Straight to the sign-in tab, private so the account already signed in doesn't answer. */}
        <button
          type="button"
          disabled={adding.length > 0}
          onClick={() => actions.connect(serviceId)}
          className="flex h-12 w-full items-center gap-1.5 text-left text-text-muted outline-none transition-colors hover:text-text focus-visible:text-text disabled:opacity-50 disabled:hover:text-text-muted"
        >
          <PlusIcon className="size-4" />
          Add another account
        </button>
      </Group>
      <Group title="Tools">
        {service.tools.map((tool) => (
          // What each tool costs every session's context.
          <Row key={tool.name} label={<span className="font-mono text-[12.5px]">{tool.name}</span>}>
            <span className="text-[12px] text-text-muted tabular-nums">{formatTokens(tool.tokens)} tokens</span>
          </Row>
        ))}
      </Group>
      <Group title="About">
        {service.blurb && <Row label={service.blurb} />}
        <Row label="Publisher">
          <span className="text-text-muted">{service.publisher}</span>
        </Row>
        <Row label="Server">
          <span className="text-text-muted">{service.transport === "remote" ? service.host : "Runs on this Mac"}</span>
        </Row>
      </Group>
    </SettingsPage>
  );
}

/* ── One provider server ────────────────────────────────────────────── */

/** A machine's copies, titled by the machine with its glyph: a laptop for this Mac, a server for a remote box. */
function MachineGroup({ machine, children }: { machine: Machine; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex min-h-6 items-center gap-1.5 px-2.5 text-[12px] font-medium text-text-muted">
        <MachineGlyph machine={machine} className="size-3.5" />
        {machine.online ? machine.name : `${machine.name} · offline`}
      </h2>
      <Card>{children}</Card>
    </section>
  );
}

function ServerPage({ groupKey }: { groupKey: string }) {
  const s = useIntegrations();
  const group = groupsOf(s).find((g) => g.key === groupKey);
  useEffect(() => {
    if (!group) home();
  }, [group]);
  if (!group) return null;
  const first = group.servers[0]!;
  const service = serviceOf(first.serviceId);
  const remote = group.servers.find((x) => x.transport !== "stdio");
  const crewHas = !!first.serviceId && s.accounts.some((a) => a.serviceId === first.serviceId);
  const anyOn = group.servers.some((x) => !x.offInCrew);
  const canMove = !!remote && !!service && !service.refusesCrew && !crewHas && anyOn;
  const machines = uniq(group.servers.map((x) => x.machine));
  const removable = group.servers.filter((x) => machineOf(s, x.machine).online);
  const uninstall = (ids: string[]) => {
    if (ids.length === group.servers.length) home();
    actions.uninstallServers(ids);
  };
  return (
    <SettingsPage title={group.name} hideHeader>
      <Header
        mark={<ServerMark server={first} size={40} />}
        title={group.name}
        subtitle={`${plural(first.tools, "tool")} · ${formatTokens(first.tokens)} tokens per session`}
        action={
          removable.length > 0 && (
            <RemoveButton
              label={`Remove ${group.name}`}
              confirm={{
                title: `Remove ${group.name}?`,
                description: "This action can’t be undone.",
                action: "Remove",
                onConfirm: () => uninstall(removable.map((x) => x.id)),
              }}
            />
          )
        }
      />
      {canMove && (
        <Callout
          icon={ArrowUpRightIcon}
          title="Move to Crew"
          description="One sign-in for every CLI, kept in the vault."
          action={
            <Button className="h-7 px-2.5 text-[12px]" onClick={() => ui.open({ kind: "connect", serviceId: first.serviceId!, moveFrom: remote.id })}>
              Move
            </Button>
          }
        />
      )}
      {machines.map((id) => {
        const m = machineOf(s, id);
        return (
          <MachineGroup key={id} machine={m}>
            {group.servers
              .filter((x) => x.machine === id)
              .map((server) => (
                <CliRow key={server.id} server={server} onUninstall={m.online && group.servers.length > 1 ? () => uninstall([server.id]) : undefined} />
              ))}
          </MachineGroup>
        );
      })}
    </SettingsPage>
  );
}
