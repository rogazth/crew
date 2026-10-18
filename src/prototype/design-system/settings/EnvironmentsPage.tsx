// PROTOTYPE — throwaway. Environments: this Mac and every machine sessions can
// run on, each a raised card with where it is, how it's connected, the
// workspaces that live there and the agent CLIs it has, then the network
// switches. Adding one is a guided dialog (AddMachineFlow). Simulated
// (envMock.ts, mock.ts); the real page is surfaces/EnvironmentSettings.tsx.
import { Menu } from "@base-ui/react/menu";
import {
  ArrowRightIcon,
  ArrowUpCircleIcon,
  BotIcon,
  CircleAlertIcon,
  EllipsisIcon,
  FolderIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Alert, Button, Field, Footer, IconButton, Overlay, PANEL, ROW, Switch, TextInput } from "../../../chrome/kit";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { AddMachineFlow } from "./AddMachineFlow";
import {
  CURRENT_CREWD,
  TAILNET,
  reconnectEnv,
  removeEnv,
  renameEnv,
  restartDaemon,
  updateCrewd,
  hereOf,
  useEnvs,
  whereOf,
  type EnvMock,
} from "./envMock";
import { EnvGlyph, StateChip } from "./envParts";
import { useAllProviders, type ProviderMock } from "./mock";
import { manageProviders } from "./route";
import { Chip, Group, Row, SettingsPage, ToggleRow, toast } from "./ui";

let prefs = { relay: true, wake: true };

export function EnvironmentsPage() {
  const envs = useEnvs();
  const providers = useAllProviders();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<EnvMock | null>(null);
  const [removing, setRemoving] = useState<EnvMock | null>(null);
  const [logs, setLogs] = useState<EnvMock | null>(null);
  const [net, setNet] = useState(prefs);
  const setPref = (change: Partial<typeof prefs>) => {
    prefs = { ...net, ...change };
    setNet(prefs);
  };

  return (
    <SettingsPage
      title="Environments"
      actions={
        <Button variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>
          Add machine
        </Button>
      }
    >
      <section className="flex flex-col gap-3" data-setting="machines">
        <div className="flex flex-col gap-5">
          {envs.map((env) => (
            <MachineCard
              key={env.id}
              env={env}
              providers={providers[env.id] ?? []}
              onRename={() => setRenaming(env)}
              onRemove={() => setRemoving(env)}
              onLogs={() => setLogs(env)}
            />
          ))}
          <AddTile onAdd={() => setAdding(true)} />
        </div>
      </section>

      <Group title="Network">
        <Row
          id="tailscale"
          label="Tailscale"
          description="Peer-to-peer over your tailnet."
        >
          <Chip tone="success">Connected</Chip>
          <span className="text-[12px] text-text-muted">{TAILNET.account}</span>
        </Row>
        <ToggleRow
          id="warn-relay"
          label="Relay warnings"
          description="Flag machines on a slower relayed path."
          checked={net.relay}
          onChange={(relay) => setPref({ relay })}
        />
        <ToggleRow
          id="wake"
          label="Reconnect on wake"
          description="Don't wait for the next heartbeat."
          checked={net.wake}
          onChange={(wake) => setPref({ wake })}
        />
      </Group>

      {adding && <AddMachineFlow onClose={() => setAdding(false)} />}
      {renaming && <RenameDialog env={renaming} onClose={() => setRenaming(null)} />}
      {removing && <RemoveDialog env={removing} onClose={() => setRemoving(null)} />}
      {logs && <LogsDialog env={logs} onClose={() => setLogs(null)} />}
    </SettingsPage>
  );
}

/* ── One machine ────────────────────────────────────────────────────── */

type Action = { label: string; icon: LucideIcon; run: () => void; disabled?: boolean; danger?: boolean };

/**
 * One machine: name and state on the first line, where it is under it, then
 * at most one short notice and four facts in two airy columns. Everything else
 * lives in the menu.
 */
function MachineCard({
  env,
  providers,
  onRename,
  onRemove,
  onLogs,
}: {
  env: EnvMock;
  providers: ProviderMock[];
  onRename: () => void;
  onRemove: () => void;
  onLogs: () => void;
}) {
  const local = env.kind === "local";
  const up = env.state === "connected" && !env.busy;
  const behind = !local && env.crewd !== CURRENT_CREWD;
  const terminal = () => toast(`Terminal opened on ${hereOf(env)}`, "info");
  const openWorkspace = () => toast(`Choose a folder on ${hereOf(env)}`, "info");
  const manage = { label: "Manage providers", icon: BotIcon, run: () => manageProviders(env.id) };
  const actions: Action[] = local
    ? [
        { label: "Open terminal", icon: SquareTerminalIcon, run: terminal },
        { label: "Open workspace…", icon: FolderOpenIcon, run: openWorkspace },
        manage,
        { label: "Restart crewd", icon: RotateCwIcon, run: () => restartDaemon(env.id) },
        { label: "View logs", icon: ScrollTextIcon, run: onLogs },
      ]
    : [
        { label: "Reconnect", icon: RefreshCwIcon, run: () => reconnectEnv(env.id), disabled: env.busy !== null },
        { label: "Open terminal", icon: SquareTerminalIcon, run: terminal, disabled: !up },
        { label: "Open workspace…", icon: FolderOpenIcon, run: openWorkspace, disabled: !up },
        manage,
        {
          label: behind ? "Update crewd" : "Reinstall crewd",
          icon: ArrowUpCircleIcon,
          run: () => updateCrewd(env.id),
          disabled: env.state === "offline" || env.busy !== null,
        },
        { label: "Restart crewd", icon: RotateCwIcon, run: () => restartDaemon(env.id), disabled: !up },
        { label: "View logs", icon: ScrollTextIcon, run: onLogs, disabled: env.state === "offline" },
        { label: "Rename…", icon: PencilIcon, run: onRename },
        { label: "Remove…", icon: Trash2Icon, run: onRemove, danger: true },
      ];

  return (
    <article data-setting={`env-${env.id}`} className="flex flex-col rounded-[14px] bg-card">
      <header className="flex items-center gap-4 px-5 pt-5 pb-4">
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-[10px] bg-canvas shadow-[0_0_0_1px_var(--color-hairline)] ${env.state === "offline" ? "text-placeholder" : "text-icon"}`}
        >
          <EnvGlyph env={env} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">{env.name}</h3>
            <StateChip env={env} />
          </div>
          <p className="truncate text-[12px] text-text-muted" title={`${whereOf(env)} · ${env.os} · ${env.arch}`}>
            <span className="font-mono text-[11.5px]">{whereOf(env)}</span> · {env.os}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {up && <IconButton icon={SquareTerminalIcon} label={`Open a terminal on ${env.name}`} title="Open terminal" onClick={terminal} />}
          <MachineMenu env={env} actions={actions} />
        </span>
      </header>
      <Notice env={env} />
      <dl className="mx-5 grid grid-cols-1 gap-x-10 gap-y-5 border-t border-hairline pt-4 pb-5 @[560px]:grid-cols-2">
        <Stat label="Connection" sub={<Version env={env} />}>
          <Connection env={env} />
        </Stat>
        <Stat label="Load" sub={env.state === "offline" ? null : env.memory}>
          {env.state === "offline" ? (
            <span className="text-text-muted">—</span>
          ) : (
            <span className="tabular-nums">
              {env.load.toFixed(2)} <span className="text-text-muted">/ {env.cpus} cores</span>
            </span>
          )}
        </Stat>
        <Stat label="Workspaces">
          {env.workspaces.length === 0 ? (
            <>
              <span className="text-text-muted">None</span>
              {up && (
                <button type="button" onClick={openWorkspace} className="text-[12px] font-medium text-accent hover:underline">
                  Open
                </button>
              )}
            </>
          ) : (
            env.workspaces.map((name) => (
              <span key={name} className="inline-flex h-6 items-center gap-1.5 rounded-md bg-canvas px-2 text-[12px] shadow-[0_0_0_1px_var(--color-hairline)]">
                <FolderIcon className="size-3.5 text-icon" />
                {name}
              </span>
            ))
          )}
        </Stat>
        <Stat label="Agents" sub={<AgentsLine env={env} providers={providers} />}>
          <Agents env={env} providers={providers} />
        </Stat>
      </dl>
    </article>
  );
}

/** A label over its value, with at most one muted line under it. */
function Stat({ label, sub, children }: { label: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[12px] text-text-muted">{label}</dt>
      <dd className="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
      {sub && <dd className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-text-muted">{sub}</dd>}
    </div>
  );
}

function Connection({ env }: { env: EnvMock }) {
  if (env.kind === "local") return <span>Local</span>;
  if (env.busy || env.state === "connecting") return <span className="text-text-muted">{env.busy ?? "Connecting"}…</span>;
  if (env.state === "offline") return <span className="text-text-muted">—</span>;
  return (
    <span className="tabular-nums">
      {env.latency} ms <span className="text-text-muted">· {env.relay ? "Relayed" : "Direct"}</span>
    </span>
  );
}

function Version({ env }: { env: EnvMock }) {
  const behind = env.kind !== "local" && env.crewd !== CURRENT_CREWD && env.state === "connected" && !env.busy;
  return (
    <>
      <span>crewd {env.crewd}</span>
      {behind && (
        <button type="button" onClick={() => updateCrewd(env.id)} className="font-medium text-accent hover:underline">
          Update
        </button>
      )}
    </>
  );
}

function Agents({ env, providers }: { env: EnvMock; providers: ProviderMock[] }) {
  return (
    <button
      type="button"
      onClick={() => manageProviders(env.id)}
      title="Manage providers"
      aria-label={`Manage providers on ${env.name}`}
      className="-mx-1 flex items-center gap-1 rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      {providers.map((p) => (
        <span
          key={p.id}
          title={p.version ? `${p.name} ${p.version}${p.account ? "" : " · signed out"}` : `${p.name} · not installed`}
          className={`relative grid size-6 place-items-center rounded-md ${p.version ? "bg-canvas shadow-[0_0_0_1px_var(--color-hairline)]" : ""}`}
        >
          <ProviderIcon provider={p.id} className={`size-3.5 ${p.version ? "" : "opacity-40 grayscale"}`} />
          {p.version && !p.account && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning ring-2 ring-canvas" />}
        </span>
      ))}
    </button>
  );
}

function AgentsLine({ env, providers }: { env: EnvMock; providers: ProviderMock[] }) {
  const installed = providers.filter((p) => p.version).length;
  const running = env.state === "offline" ? 0 : env.agentsRunning;
  return (
    <span className="tabular-nums">
      {installed} of {providers.length} installed
      {running > 0 && ` · ${running} running`}
    </span>
  );
}

/** One line, at most one action: what's wrong and the way past it. */
function Notice({ env }: { env: EnvMock }) {
  let text: string | null = null;
  let detail: string | undefined;
  let danger = false;
  let action: { label: string; run: () => void } | null = null;
  if (env.busy || env.state === "connecting") return null;
  if (env.state === "offline") {
    danger = true;
    text = `Unreachable · last seen ${env.lastSeen}`;
    detail = env.error ?? undefined;
    action = { label: "Retry", run: () => reconnectEnv(env.id) };
  } else if (env.state === "error") {
    danger = true;
    text = `crewd ${env.crewd} is outdated`;
    detail = env.error ?? undefined;
    action = { label: "Update", run: () => updateCrewd(env.id) };
  } else if (env.relay && prefs.relay) {
    text = "Relayed connection · terminals may lag";
    detail = "Open UDP 41641 on that network for a direct path.";
  }
  if (!text) return null;
  const Icon = danger ? CircleAlertIcon : TriangleAlertIcon;
  return (
    <div
      title={detail}
      className={`mx-5 mb-4 flex h-9 items-center gap-2.5 rounded-lg px-3 text-[12px] ${danger ? "bg-danger/8" : "bg-warning/10"}`}
    >
      <Icon className={`size-3.5 shrink-0 ${danger ? "text-danger" : "text-warning"}`} />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {action && (
        <button
          type="button"
          onClick={action.run}
          className={`shrink-0 font-medium hover:underline ${danger ? "text-danger" : "text-warning"}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function MachineMenu({ env, actions }: { env: EnvMock; actions: Action[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton icon={EllipsisIcon} label={`More for ${env.name}`} className="data-popup-open:bg-hover" />} />
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            {actions.map((action) => (
              <div key={action.label}>
                {action.danger && <Menu.Separator className="mx-2 my-1 h-px bg-hairline" />}
                <Menu.Item
                  disabled={action.disabled ?? false}
                  onClick={action.run}
                  className={`${ROW} data-disabled:opacity-40 ${action.danger ? "text-danger" : ""}`}
                >
                  <action.icon className={`size-4 ${action.danger ? "" : "text-icon"}`} />
                  {action.label}
                </Menu.Item>
              </div>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function AddTile({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      data-setting="add-machine"
      onClick={onAdd}
      className="flex items-center gap-4 rounded-[20px] bg-card px-5 py-4 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-canvas text-icon">
        <PlusIcon className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">Add a machine</span>
        <span className="text-[12px] text-text-muted">Any SSH or Tailscale host.</span>
      </span>
      <ArrowRightIcon className="size-4 shrink-0 text-icon" />
    </button>
  );
}

/* ── Dialogs ────────────────────────────────────────────────────────── */

function RenameDialog({ env, onClose }: { env: EnvMock; onClose: () => void }) {
  const [name, setName] = useState(env.name);
  const clean = name.trim();
  const save = () => {
    if (!clean) return;
    renameEnv(env.id, clean);
    toast("Renamed");
    onClose();
  };
  return (
    <Alert open onDismiss={onClose} title={`Rename ${env.name}`}>
      <form
        className="px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} autoFocus onFocus={(event) => event.currentTarget.select()} />
        </Field>
      </form>
      <Footer hints={[["↩", "Save"], ["esc", "Cancel"]]}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!clean} onClick={save}>
          Save
        </Button>
      </Footer>
    </Alert>
  );
}

function RemoveDialog({ env, onClose }: { env: EnvMock; onClose: () => void }) {
  const [wipe, setWipe] = useState(false);
  return (
    <Alert
      open
      onDismiss={onClose}
      title={`Remove ${env.name}?`}
      description="Stops crewd and removes it from Crew; files stay on the machine."
    >
      <label className="mx-4 mb-4 flex cursor-pointer items-center gap-4 rounded-xl bg-card px-3.5 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          <span>Also delete ~/.crew</span>
          <span className="text-[12px] text-text-muted">Sessions and routines. Can't be undone.</span>
        </span>
        <Switch checked={wipe} onChange={setWipe} />
      </label>
      <Footer hints={[["esc", "Cancel"]]}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            removeEnv(env.id);
            toast(`${env.name} removed`);
            onClose();
          }}
        >
          Remove
        </Button>
      </Footer>
    </Alert>
  );
}

function LogsDialog({ env, onClose }: { env: EnvMock; onClose: () => void }) {
  const local = env.kind === "local";
  const lines = [
    `Oct 15 09:12:03 ${env.hostname} crewd[2114]: crewd ${env.crewd} listening on ${env.address ?? "127.0.0.1"}:${env.port}`,
    `Oct 15 09:12:03 ${env.hostname} crewd[2114]: socks proxy on ${env.port + 1}`,
    `Oct 15 09:12:04 ${env.hostname} crewd[2114]: found agent CLIs: claude${env.id === "atlas" ? ", codex" : ""}`,
    `Oct 15 09:14:41 ${env.hostname} crewd[2114]: client paired from gabriels-mbp (100.101.0.2)`,
    `Oct 15 10:02:17 ${env.hostname} crewd[2114]: session 7f3a started: claude in ~/${env.workspaces[0] ?? "work"}`,
    `Oct 15 10:31:55 ${env.hostname} crewd[2114]: heartbeat ok (${env.latency ?? 2} ms)`,
  ];
  return (
    <Overlay onClose={onClose} width="w-[720px]" label={`${env.name} daemon logs`}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <ScrollTextIcon className="size-4 text-icon" />
        <span className="font-medium">{env.name}</span>
        <span className="font-mono text-[12px] text-text-muted">
          {local ? "~/.crew/logs/crewd.log" : "journalctl --user -u crewd"}
        </span>
        <span className="flex-1" />
        <StateChip env={env} />
      </div>
      <div className="min-h-40 flex-1 overflow-auto bg-canvas px-4 py-3">
        <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap" data-selectable>
          {lines.join("\n")}
        </pre>
      </div>
      <Footer hints={[["esc", "Close"]]}>
        <Button variant="ghost" icon={RefreshCwIcon} onClick={() => toast("Logs refreshed", "info")}>
          Refresh
        </Button>
      </Footer>
    </Overlay>
  );
}
