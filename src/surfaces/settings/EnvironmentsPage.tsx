// Environments: this Mac and every machine sessions can run on, each a raised
// card with where it is, how it's connected, the connection and load as small
// charts, then the network switches. Adding one is a guided dialog
// (AddMachineFlow). Simulated (pending.ts) and not reachable in the app until
// S4 of docs/plans/2026-10-19-design-system-finish.md; the real page is
// surfaces/EnvironmentSettings.tsx.
import { Menu } from "@base-ui/react/menu";
import {
  ArrowDownToLineIcon,
  ArrowRightIcon,
  ArrowUpCircleIcon,
  BotIcon,
  CircleAlertIcon,
  EllipsisIcon,
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
import { useEffect, useMemo, useState, type PointerEvent, type ReactNode } from "react";
import { Alert, Button, Field, Footer, IconButton, Overlay, PANEL, ROW, Switch, TextInput } from "../../chrome/kit";
import { subscribeAdd, takeAddRequest } from "../../lib/remoteUi";
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
} from "./pending";
import { EnvGlyph, StateChip } from "./pendingParts";
import { manageProviders } from "./route";
import { Callout, Chip, Group, Row, SettingsPage, ToggleRow, toast } from "./ui";

let prefs = { relay: true, wake: true };

export function EnvironmentsPage() {
  const envs = useEnvs();
  // "Add a machine…" from the machine picker lands here, as on the shipped page.
  const [adding, setAdding] = useState(() => takeAddRequest());
  useEffect(() => subscribeAdd(() => setAdding(true)), []);
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
        <div className="flex flex-col gap-3">
          {envs.map((env) => (
            <MachineCard
              key={env.id}
              env={env}
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
 * at most one short notice and a single strip with the connection and two
 * small load charts. Everything else lives in the menu.
 */
function MachineCard({
  env,
  onRename,
  onRemove,
  onLogs,
}: {
  env: EnvMock;
  onRename: () => void;
  onRemove: () => void;
  onLogs: () => void;
}) {
  const local = env.kind === "local";
  const up = env.state === "connected" && !env.busy;
  const behind = !local && env.crewd !== CURRENT_CREWD;
  const offline = env.state === "offline";
  const memory = parseMemory(env.memory);
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
      <header className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span
          className={`grid size-9 shrink-0 place-items-center rounded-[9px] bg-canvas shadow-[0_0_0_1px_var(--color-hairline)] ${env.state === "offline" ? "text-placeholder" : "text-icon"}`}
        >
          <EnvGlyph env={env} className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em]">{env.name}</h3>
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
      <dl className="mx-4 grid grid-cols-1 gap-x-8 gap-y-3 border-t border-hairline py-3 @[560px]:grid-cols-[1.2fr_1fr_1fr]">
        <Stat label="Connection" sub={<Version env={env} />}>
          <Connection env={env} />
        </Stat>
        <Stat label="CPU" sub={offline ? null : `${env.load.toFixed(2)} of ${env.cpus} cores`}>
          {offline ? (
            <span className="text-text-muted">—</span>
          ) : (
            <Sparkline
              seed={`${env.id}-cpu`}
              level={Math.min(env.load / Math.max(env.cpus, 1), 1)}
              format={(v) => `${(v * env.cpus).toFixed(2)} load · ${Math.round(v * 100)}%`}
            />
          )}
        </Stat>
        <Stat label="Memory" sub={offline ? null : memory.label}>
          {offline ? (
            <span className="text-text-muted">—</span>
          ) : (
            <Sparkline
              seed={`${env.id}-mem`}
              level={memory.used ?? 0.4}
              format={(v) => `${(v * memory.total).toFixed(memory.total < 10 ? 1 : 0)} of ${memory.total} GB · ${Math.round(v * 100)}%`}
            />
          )}
        </Stat>
      </dl>
    </article>
  );
}

/** A label over its value, with at most one muted line under it. */
function Stat({ label, sub, children }: { label: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-text-muted">{label}</dt>
      <dd className="flex min-h-5 min-w-0 flex-wrap items-center gap-1.5 text-[13px]">{children}</dd>
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

const SAMPLES = 24;
const STEP_MIN = 5;

/**
 * A small history chart ending at `level` (0–1 of capacity). Moving over it
 * scrubs a marker along the timeline and shows that sample's time and usage.
 * The history is simulated: the mock only knows the current value.
 */
function Sparkline({ seed: key, level, format }: { seed: string; level: number; format: (value: number) => string }) {
  const w = 120;
  const h = 28;
  const [now] = useState(() => Date.now());
  const [at, setAt] = useState<number | null>(null);
  const values = useMemo(() => {
    const base = [...key].reduce((n, c) => n + c.charCodeAt(0), 7);
    return Array.from({ length: SAMPLES }, (_, i) => {
      const noise = Math.sin((base + i) * 12.9898) * 43758.5453;
      const wobble = (noise - Math.floor(noise) - 0.5) * Math.max(level * 0.7, 0.04);
      return i === SAMPLES - 1 ? level : Math.min(Math.max(level + wobble, 0), 1);
    });
  }, [key, level]);
  const x = (i: number) => (i / (SAMPLES - 1)) * w;
  const y = (v: number) => h - 2 - v * (h - 4);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const time = (i: number) =>
    i === SAMPLES - 1
      ? "Now"
      : new Date(now - (SAMPLES - 1 - i) * STEP_MIN * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const scrub = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(Math.round(Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1) * (SAMPLES - 1)));
  };
  return (
    <span className="relative -mx-1 inline-flex px-1 py-0.5">
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`Last ${(SAMPLES - 1) * STEP_MIN} minutes, now ${format(level)}`}
        className="touch-none text-accent"
        onPointerMove={scrub}
        onPointerLeave={() => setAt(null)}
      >
        <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        {at !== null && (
          <>
            <line x1={x(at)} x2={x(at)} y1={0} y2={h} stroke="currentColor" strokeWidth={1} opacity={0.35} />
            <circle cx={x(at)} cy={y(values[at]!)} r={3} fill="currentColor" stroke="var(--color-card)" strokeWidth={1.5} />
          </>
        )}
      </svg>
      {at !== null && (
        <span
          role="tooltip"
          style={{ left: x(at) + 4 }}
          className="pointer-events-none absolute bottom-full z-50 mb-1.5 -translate-x-1/2 rounded-lg bg-accent px-2 py-1 text-[12px] leading-4 whitespace-nowrap text-inverse shadow-float"
        >
          <span className="text-inverse/70">{time(at)}</span> · {format(values[at]!)}
        </span>
      )}
    </span>
  );
}

/** Memory strings read "41 GB free of 64 GB" or just a total ("36 GB"). */
function parseMemory(text: string): { used: number | null; total: number; label: string } {
  const m = /^([\d.]+) GB free of ([\d.]+) GB$/.exec(text);
  if (!m) return { used: null, total: parseFloat(text) || 0, label: text };
  const free = Number(m[1]);
  const total = Number(m[2]);
  return { used: 1 - free / total, total, label: `${(total - free).toFixed(total < 10 ? 1 : 0)} of ${total} GB used` };
}

/** At most one notice, in the alert's shape: what's wrong and the way past it. */
function Notice({ env }: { env: EnvMock }) {
  if (env.busy || env.state === "connecting") return null;
  const box = "mx-4 mb-3";
  if (env.state === "offline")
    return (
      <Callout
        className={box}
        tone="danger"
        icon={CircleAlertIcon}
        title="Unreachable"
        description={env.error ?? `Last seen ${env.lastSeen}`}
        action={<Button onClick={() => reconnectEnv(env.id)}>Retry</Button>}
      />
    );
  if (env.state === "error")
    return (
      <Callout
        className={box}
        tone="accent"
        icon={ArrowDownToLineIcon}
        title="Update available for crewd"
        description={`This machine runs ${env.crewd}; update it to keep working here.`}
        action={
          <Button variant="primary" onClick={() => updateCrewd(env.id)}>
            Update
          </Button>
        }
      />
    );
  if (env.relay && prefs.relay)
    return (
      <Callout
        className={box}
        tone="warning"
        icon={TriangleAlertIcon}
        title="Relayed connection"
        description="Terminals may lag. Open UDP 41641 on that network for a direct path."
      />
    );
  return null;
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
