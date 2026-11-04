// Environments: this Mac and every machine sessions can run on, each a raised
// card with where it is, how it's connected, the connection and load as small
// charts, then the network switches. Everything is real: the links come from
// the registry, the actions through remotesHost(), the charts from the
// daemon's own samples.
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpCircleIcon,
  BotIcon,
  CircleAlertIcon,
  CopyIcon,
  EllipsisIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
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
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { EnvGlyph } from "../../chrome/EnvBits";
import { Alert, Button, Field, Footer, IconButton, Overlay, PANEL, ROW, Switch, TextInput, Tooltip } from "../../chrome/kit";
import { useEnvLinks } from "../../hooks/useEnvLinks";
import { useMachineMetrics } from "../../hooks/useMachineMetrics";
import * as api from "../../lib/api";
import { LOCAL, envOf, reconnect, refreshRemotes, type EnvLink } from "../../lib/client/registry";
import { whereOf } from "../../lib/envText";
import { openUrl, remotesHost } from "../../lib/host";
import type { MachineSample } from "../../lib/protocol";
import { compareVersions, errorText as message, type RemoteUpdateState, type Tailnet } from "../../lib/remotes";
import { openWorkspaceOn, subscribeAdd, takeAddRequest } from "../../lib/remoteUi";
import { READS, keep, useKept } from "../../lib/settingsReads";
import type { Workspace } from "../../lib/types";
import { AddMachineFlow, TAILSCALE_DOWNLOAD } from "./AddMachineFlow";
import { manageProviders } from "./route";
import { RowAction } from "./integrations/bits";
import { Chip, Group, Row, SettingsPage, toast, type Tone } from "./ui";

type Props = {
  workspaces: Workspace[];
  onOpenTerminal: (envId: string) => Promise<void>;
};

/** A daemon job running from a card's menu, shown on the card until it ends. */
type Busy = { label: string };

export function EnvironmentsPage({ workspaces, onOpenTerminal }: Props) {
  const links = useEnvLinks();
  const host = remotesHost();
  // "Add a machine…" from the machine picker lands here, as on the shipped page.
  const [adding, setAdding] = useState(() => takeAddRequest());
  useEffect(() => subscribeAdd(() => setAdding(true)), []);
  const kept = useKept(READS.tailnet) ?? null;
  const [failed, setFailed] = useState<Tailnet | null>(null);
  const tailnet = failed ?? kept;
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  /** Updates main's updater waits on or runs. */
  const [pending, setPending] = useState<Record<string, RemoteUpdateState>>({});
  const [confirming, setConfirming] = useState<{ link: EnvLink; working: number } | null>(null);
  const [editing, setEditing] = useState<EnvLink | null>(null);
  const [removing, setRemoving] = useState<EnvLink | null>(null);
  const [logs, setLogs] = useState<EnvLink | null>(null);

  const readTailnet = useCallback(() => {
    if (!host) return;
    void host.tailnet().then(
      (next) => {
        setFailed(null);
        keep(READS.tailnet, next);
      },
      (reason: unknown) => setFailed({ state: "error", account: null, message: message(reason), devices: [] }),
    );
  }, [host]);
  useEffect(readTailnet, [readTailnet]);
  // Back from installing or signing in to Tailscale, the page already knows.
  useEffect(() => {
    window.addEventListener("focus", readTailnet);
    return () => window.removeEventListener("focus", readTailnet);
  }, [readTailnet]);

  useEffect(() => {
    if (!host) return;
    const take = (states: Record<string, RemoteUpdateState>) => {
      setPending(states);
    };
    void host.updateStates().then(take, () => {});
    return host.onUpdateStates(take);
  }, [host]);

  const local = links.find((link) => link.id === LOCAL) ?? null;
  const remotes = links.filter((link) => link.id !== LOCAL);
  const count = (envId: string) => workspaces.filter((workspace) => envOf(workspace.id) === envId).length;
  const relayed = (link: EnvLink) =>
    tailnet?.devices.some((device) => device.ip === link.host && device.relay) === true;

  async function run(link: EnvLink, label: string, work: () => Promise<unknown>) {
    setBusy((current) => ({ ...current, [link.id]: { label } }));
    try {
      await work();
    } catch (reason) {
      toast(`${link.name}: ${message(reason)}`, "danger");
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[link.id];
        return next;
      });
    }
  }

  /** Asks first when sessions are working there: the update breaks off their turns. */
  async function update(link: EnvLink) {
    const working = (await host?.busySessions(link.id).catch(() => 0)) ?? 0;
    if (working > 0) setConfirming({ link, working });
    else void updateNow(link);
  }
  const queue = (link: EnvLink) =>
    host
      ?.queueUpdate(link.id)
      .then(() => toast(`${link.name} updates when idle`))
      .catch((reason: unknown) => toast(`${link.name}: ${message(reason)}`, "danger"));
  const updateNow = (link: EnvLink) =>
    run(link, "Updating", async () => {
      const warning = (await host?.update(link.id))?.warning ?? null;
      await refreshRemotes();
      reconnect(link.id);
      // Updated and running either way; lingering off is said in place of the usual.
      toast(warning ? `${link.name}: ${warning}` : `${link.name} is up to date`, warning ? "danger" : "success");
    });
  const restart = (link: EnvLink) =>
    run(link, "Restarting", async () => {
      await host?.restart(link.id);
      reconnect(link.id);
    });
  const terminal = (link: EnvLink) =>
    onOpenTerminal(link.id).catch((reason: unknown) => toast(message(reason), "danger"));

  const noTailscale = tailnet?.state === "missing";

  function cardFor(link: EnvLink) {
    const isLocal = link.id === LOCAL;
    const newer = isLocal ? null : updateFor(link, local);
    const waiting = pending[link.id] ?? null;
    const job =
      busy[link.id] ?? (waiting?.state === "updating" ? { label: "Updating" } : null);
    const up = link.status === "online" && !link.mismatch && !job;
    const manage = { label: "Manage providers", icon: BotIcon, run: () => manageProviders(link.id) };
    const actions: Action[] = isLocal
      ? [
          { label: "Open terminal", icon: SquareTerminalIcon, run: () => void terminal(link), disabled: !up },
          { label: "Open workspace…", icon: FolderOpenIcon, run: () => openWorkspaceOn(link.id), disabled: !up },
          manage,
          { label: "Restart", icon: RotateCwIcon, run: () => void restart(link), disabled: !host || job !== null },
          { label: "View logs", icon: ScrollTextIcon, run: () => setLogs(link), disabled: !host },
        ]
      : [
          { label: "Reconnect", icon: RefreshCwIcon, run: () => reconnect(link.id), disabled: job !== null },
          { label: "Open terminal", icon: SquareTerminalIcon, run: () => void terminal(link), disabled: !up },
          { label: "Open workspace…", icon: FolderOpenIcon, run: () => openWorkspaceOn(link.id), disabled: !up },
          {
            label: newer ? `Update to ${newer}` : "Reinstall",
            icon: ArrowUpCircleIcon,
            run: () => void update(link),
            disabled: !host || job !== null,
          },
          { label: "Restart", icon: RotateCwIcon, run: () => void restart(link), disabled: !host || job !== null },
          { label: "View logs", icon: ScrollTextIcon, run: () => setLogs(link), disabled: !host },
          { label: "Edit…", icon: PencilIcon, run: () => setEditing(link) },
          { label: "Remove…", icon: Trash2Icon, run: () => setRemoving(link), danger: true, disabled: !host },
        ];
    return (
      <MachineCard
        key={link.id}
        link={link}
        newer={newer}
        relay={isLocal ? false : relayed(link)}
        busy={job}
        actions={actions}
        onUpdate={host ? () => void update(link) : undefined}
        onReconnect={() => reconnect(link.id)}
      />
    );
  }

  return (
    <SettingsPage
      title="Environments"
      actions={
        host && !noTailscale && (
          <Button data-setting="add-machine" variant="primary" icon={PlusIcon} onClick={() => setAdding(true)}>
            Add machine
          </Button>
        )
      }
    >
      {!noTailscale && <section className="flex flex-col gap-3" data-setting="machines">
        <div className="flex flex-col gap-3">
          {local ? cardFor(local) : <StartingCard />}
          {remotes.map(cardFor)}
        </div>
      </section>}

      {host && adding && <AddMachineFlow known={tailnet} onClose={() => { setAdding(false); readTailnet(); }} />}

      {noTailscale && (
        <div className="flex flex-col items-center gap-1 py-24 text-center">
          <p className="text-[14px] font-medium">Install Tailscale</p>
          <p className="text-text-muted">Needed to connect your other machines.</p>
          <Button variant="primary" className="mt-2.5" onClick={() => void openUrl(TAILSCALE_DOWNLOAD)}>
            Get Tailscale
          </Button>
        </div>
      )}

      {!noTailscale && <Group title="Network">
        <Row id="tailscale" label="Tailscale" description="Peer-to-peer over your tailnet.">
          <TailnetState tailnet={tailnet} available={host !== null} />
        </Row>
      </Group>}

      {confirming && (
        <UpdateDialog
          link={confirming.link}
          working={confirming.working}
          onClose={() => setConfirming(null)}
          onNow={() => {
            setConfirming(null);
            void updateNow(confirming.link);
          }}
          onLater={() => {
            setConfirming(null);
            void queue(confirming.link);
          }}
        />
      )}

      {logs && <LogsDialog link={logs} onClose={() => setLogs(null)} />}
      {editing && (
        <EditDialog
          link={editing}
          onClose={() => setEditing(null)}
          onSave={async (edit) => {
            const link = editing;
            if (!link.host || link.port === null) throw new Error("No address on record, so it can’t be edited.");
            // The address itself is kept blank for ssh: a machine added before used it.
            const ssh = edit.ssh === link.host ? "" : edit.ssh;
            await api.upsertRemote({ id: link.id, name: edit.name, host: link.host, port: link.port, user: edit.user, ssh });
            await refreshRemotes();
          }}
        />
      )}
      {removing && host && (
        <RemoveDialog
          link={removing}
          workspaces={count(removing.id)}
          onClose={() => setRemoving(null)}
          onRemove={async (wipe) => {
            const { warning } = await host.remove(removing.id, wipe);
            await refreshRemotes();
            readTailnet();
            toast(warning ?? `${removing.name} removed`, warning ? "danger" : "success");
          }}
        />
      )}
    </SettingsPage>
  );
}

/** The newer crewd this machine could run, when this Mac's is ahead of it. */
function updateFor(link: EnvLink, local: EnvLink | null): string | null {
  if (link.mismatch) return local?.version ?? "the current version";
  if (!local?.version || !link.version) return null;
  return compareVersions(link.version, local.version) < 0 ? local.version : null;
}

/* ── One machine ────────────────────────────────────────────────────── */

type Action = { label: string; icon: LucideIcon; run: () => void; disabled?: boolean; danger?: boolean };

function stateOf(link: EnvLink, busy: Busy | null, relay: boolean): { tone: Tone; label: string } {
  if (busy) return { tone: "accent", label: `${busy.label}…` };
  if (link.mismatch) return { tone: "danger", label: "Needs update" };
  if (link.status === "offline") return { tone: "danger", label: "Offline" };
  if (link.status === "connecting") return { tone: "warning", label: "Connecting…" };
  if (link.id === LOCAL) return { tone: "success", label: "Running" };
  return relay ? { tone: "warning", label: "Relayed" } : { tone: "success", label: "Connected" };
}

/** This Mac's card while its daemon is still coming up. */
function StartingCard() {
  return (
    <article className="flex items-center gap-3 rounded-[14px] bg-card px-4 py-4 text-text-muted">
      <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-canvas shadow-[0_0_0_1px_var(--color-hairline)]">
        <EnvGlyph link={null} className="size-[18px]" />
      </span>
      Starting the daemon…
    </article>
  );
}

/**
 * One machine: its name and where it is, what is going on with it beside them,
 * then a single strip with the version and two small load charts. The rest
 * lives in the menu.
 */
function MachineCard({
  link,
  newer,
  relay,
  busy,
  actions,
  onUpdate,
  onReconnect,
}: {
  link: EnvLink;
  newer: string | null;
  relay: boolean;
  busy: Busy | null;
  actions: Action[];
  onUpdate: (() => void) | undefined;
  onReconnect: () => void;
}) {
  const local = link.id === LOCAL;
  const live = link.status === "online" && !link.mismatch;
  const { samples } = useMachineMetrics(live ? link.id : null);
  const last = samples.at(-1);
  const info = link.info;
  // In progress, it says so where its action would be.
  const progress = busy ? busy.label : link.status === "connecting" ? "Connecting" : null;
  const where = local ? (info?.hostname ?? null) : whereOf(link);
  const about = where && info?.os ? `${where} (${info.os})` : (where ?? info?.os ?? "");
  const dash = <span className="text-text-muted">—</span>;

  return (
    <article data-setting={`env-${link.id}`} className="flex flex-col rounded-[14px] bg-card">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span
          className={`grid size-9 shrink-0 place-items-center rounded-[9px] bg-canvas shadow-[0_0_0_1px_var(--color-hairline)] text-icon`}
        >
          <EnvGlyph link={link} className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em]">{link.name}</h3>
          </div>
          <p className="truncate text-[12px] text-text-muted" title={about}>
            {about}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <Status link={link} relay={relay} progress={progress} newer={newer} onUpdate={onUpdate} onReconnect={onReconnect} />
          <MachineMenu link={link} actions={actions} />
        </span>
      </header>
      <dl className="mx-4 grid grid-cols-1 gap-x-8 gap-y-3 border-t border-hairline py-3 @[560px]:grid-cols-[1.2fr_1fr_1fr]">
        <Stat label="Version">
          <Version link={link} newer={newer} />
        </Stat>
        <Stat label="CPU" sub={live && info ? `${info.load.toFixed(2)} on ${plural(info.cpus, "core")}` : null} chart>
          {live && samples.length > 0 ? (
            <Sparkline
              samples={samples}
              value={(sample) => sample.cpuPercent / 100}
              format={(sample) => `${Math.round(sample.cpuPercent)}%`}
            />
          ) : (
            dash
          )}
        </Stat>
        <Stat label="Memory" sub={live ? memorySub(last, info) : null} chart>
          {live && samples.length > 0 ? (
            <Sparkline
              samples={samples}
              value={(sample) => (sample.memTotal > 0 ? sample.memUsed / sample.memTotal : 0)}
              format={(sample) => `${bytes(sample.memUsed)} of ${bytes(sample.memTotal)} (${Math.round((sample.memUsed / Math.max(sample.memTotal, 1)) * 100)}%)`}
            />
          ) : (
            dash
          )}
        </Stat>
      </dl>
    </article>
  );
}

/** A label over its value, with at most one muted line under it. A `chart` keeps the sparkline's height before its first sample. */
function Stat({ label, sub, chart = false, children }: { label: string; sub?: ReactNode; chart?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-text-muted">{label}</dt>
      <dd className={`flex ${chart ? "min-h-8" : "min-h-5"} min-w-0 flex-wrap items-center gap-1.5 text-[13px]`}>{children}</dd>
      {sub && <dd className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-text-muted">{sub}</dd>}
    </div>
  );
}

/** What crewd runs there; with an update, what it runs and what it goes to. */
function Version({ link, newer }: { link: EnvLink; newer: string | null }) {
  if (!link.version) return <span className="text-text-muted">—</span>;
  if (!newer) return <span className="tabular-nums">{link.version}</span>;
  return (
    <span className="tabular-nums">
      <s>{link.version}</s> → {newer}
    </span>
  );
}

function memorySub(sample: MachineSample | undefined, info: EnvLink["info"]): string | null {
  if (sample && sample.memTotal > 0) return `${bytes(sample.memUsed)} of ${bytes(sample.memTotal)} used`;
  if (info) return memory(info.memoryTotal, info.memoryAvailable);
  return null;
}

/** What is going on with a machine, on one line where its action would be, and the way past it. All well says nothing. */
function Status({
  link,
  relay,
  progress,
  newer,
  onUpdate,
  onReconnect,
}: {
  link: EnvLink;
  relay: boolean;
  progress: string | null;
  newer: string | null;
  onUpdate: (() => void) | undefined;
  onReconnect: () => void;
}) {
  if (progress)
    return (
      <span className="flex items-center gap-1.5 pr-1 text-[12px] text-text-muted">
        <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
        {progress}
      </span>
    );
  if (link.mismatch)
    return (
      <>
        <Trouble icon={TriangleAlertIcon} ink="text-danger" text="Incompatible" why="Update it to open workspaces." />
        {onUpdate && <RowAction label="Update" onClick={onUpdate} />}
      </>
    );
  if (link.status === "offline") {
    if (link.id === LOCAL) return <Trouble icon={CircleAlertIcon} ink="text-danger" text="Offline" why="Not responding." />;
    return (
      <>
        <Trouble
          icon={CircleAlertIcon}
          ink="text-danger"
          text="Can't reach"
          why={link.error ?? (link.lastSeen ? `Last seen ${ago(link.lastSeen)}` : "Not connected yet.")}
        />
        <RowAction label="Try again" onClick={onReconnect} />
      </>
    );
  }
  if (relay && link.status === "online") return <Trouble icon={TriangleAlertIcon} ink="text-warning" text="Slow connection" why="Terminals may lag." />;
  if (newer && onUpdate) return <RowAction label="Update" onClick={onUpdate} />;
  return null;
}

function Trouble({ icon: Glyph, ink, text, why }: { icon: LucideIcon; ink: string; text: string; why: string }) {
  return (
    <Tooltip
      content={why}
      render={<span className="flex items-center gap-1.5 pr-1 text-[12px] text-text-muted" />}
    >
      <Glyph className={`size-3.5 shrink-0 ${ink}`} />
      {text}
    </Tooltip>
  );
}

/**
 * A history chart over the daemon's own samples (0–1 of capacity). Moving over
 * it scrubs a marker along the timeline and shows that sample's real time and
 * reading.
 */
function Sparkline({
  samples,
  value,
  format,
}: {
  samples: MachineSample[];
  value: (sample: MachineSample) => number;
  format: (sample: MachineSample) => string;
}) {
  const w = 120;
  const h = 28;
  const [at, setAt] = useState<number | null>(null);
  const [now] = useState(() => Date.now());
  const first = samples[0]!.at;
  const lastAt = samples[samples.length - 1]!.at;
  const span = lastAt - first;
  const x = (sample: MachineSample) => (span > 0 ? ((sample.at - first) / span) * w : w);
  const y = (sample: MachineSample) => h - 2 - Math.min(Math.max(value(sample), 0), 1) * (h - 4);
  const points = samples.map((sample) => `${x(sample).toFixed(1)},${y(sample).toFixed(1)}`);
  const picked = at !== null ? samples[Math.min(at, samples.length - 1)]! : null;
  const time = (sample: MachineSample) =>
    sample === samples[samples.length - 1] && now - sample.at < 90_000
      ? "Now"
      : new Date(sample.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const scrub = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const target = first + Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1) * span;
    let best = 0;
    samples.forEach((sample, index) => {
      if (Math.abs(sample.at - target) < Math.abs(samples[best]!.at - target)) best = index;
    });
    setAt(best);
  };
  const minutes = Math.max(Math.round(span / 60_000), 1);
  return (
    <span className="relative -mx-1 inline-flex px-1 py-0.5">
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`Last ${minutes} minutes, now ${format(samples[samples.length - 1]!)}`}
        className="touch-none text-accent"
        onPointerMove={scrub}
        onPointerLeave={() => setAt(null)}
      >
        {samples.length > 1 && (
          <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {samples.length === 1 && <circle cx={w} cy={y(samples[0]!)} r={2} fill="currentColor" />}
        {picked && (
          <>
            <line x1={x(picked)} x2={x(picked)} y1={0} y2={h} stroke="currentColor" strokeWidth={1} opacity={0.35} />
            <circle cx={x(picked)} cy={y(picked)} r={3} fill="currentColor" stroke="var(--color-card)" strokeWidth={1.5} />
          </>
        )}
      </svg>
      {picked && (
        <span
          role="tooltip"
          style={{ left: x(picked) + 4 }}
          className="pointer-events-none absolute bottom-full z-50 mb-1.5 -translate-x-1/2 rounded-lg bg-accent px-2 py-1 text-[12px] leading-4 whitespace-nowrap text-inverse shadow-float"
        >
          <span className="mr-1.5 text-inverse/70">{time(picked)}</span>
          {format(picked)}
        </span>
      )}
    </span>
  );
}

function MachineMenu({ link, actions }: { link: EnvLink; actions: Action[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton icon={EllipsisIcon} label={`More for ${link.name}`} className="data-popup-open:bg-hover" />} />
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

function TailnetState({ tailnet, available }: { tailnet: Tailnet | null; available: boolean }) {
  if (!available) return <span className="text-[12px] text-text-muted">Only in the app</span>;
  if (!tailnet) return <span className="text-[12px] text-text-muted">Checking…</span>;
  // All well says who it is signed in as, and nothing more.
  if (tailnet.state === "running") return <span className="text-[12px] text-text-muted">{tailnet.account ?? "Connected"}</span>;
  const Glyph = tailnet.state === "error" ? CircleAlertIcon : TriangleAlertIcon;
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-text-muted">
      <Glyph className={`size-3.5 shrink-0 ${tailnet.state === "error" ? "text-danger" : "text-warning"}`} />
      {tailnet.message ?? "Not running"}
    </span>
  );
}

/* ── Dialogs ────────────────────────────────────────────────────────── */

type Edit = { name: string; ssh: string; user: string };

/** A machine's name, and how ssh reaches it: a Host from ~/.ssh/config, or an address. */
function EditDialog({ link, onClose, onSave }: { link: EnvLink; onClose: () => void; onSave: (edit: Edit) => Promise<void> }) {
  const [name, setName] = useState(link.name);
  const [ssh, setSsh] = useState(link.ssh ?? link.host ?? "");
  const [user, setUser] = useState(link.user ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    const next = { name: name.trim(), ssh: ssh.trim(), user: user.trim() };
    if (!next.name || !next.ssh) {
      setError(!next.name ? "It needs a name." : "It needs an SSH host.");
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      toast("Saved");
      onClose();
    } catch (reason) {
      setError(message(reason));
      setSaving(false);
    }
  }
  return (
    <Alert open onDismiss={onClose} title={`Edit ${link.name}`} description="SSH is only for installs, updates and logs." error={error}>
      <form
        className="flex flex-col gap-3 px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Name" hint="Shown in the rail, ⌘O and notifications.">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} autoFocus onFocus={(event) => event.currentTarget.select()} />
        </Field>
        <div className="grid grid-cols-[1fr_8rem] gap-3">
          <Field label="SSH host" hint="A Host from ~/.ssh/config, or an address.">
            <TextInput value={ssh} onChange={(event) => setSsh(event.target.value)} className="font-mono text-[12.5px]" />
          </Field>
          <Field label="SSH user" hint="Blank: from the config.">
            <TextInput value={user} onChange={(event) => setUser(event.target.value)} />
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
      <Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </Footer>
    </Alert>
  );
}

/** An update asked for while sessions work there: now breaks off their turns, later waits for them. */
function UpdateDialog({
  link,
  working,
  onClose,
  onNow,
  onLater,
}: {
  link: EnvLink;
  working: number;
  onClose: () => void;
  onNow: () => void;
  onLater: () => void;
}) {
  return (
    <Alert
      open
      onDismiss={onClose}
      title={`Update ${link.name} now?`}
      description={`${plural(working, "session")} ${working === 1 ? "is" : "are"} working there. Updating breaks off ${working === 1 ? "its turn" : "their turns"}.`}
    >
      <Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onNow}>Update now</Button>
        <Button variant="primary" onClick={onLater}>
          When {working === 1 ? "it finishes" : "they finish"}
        </Button>
      </Footer>
    </Alert>
  );
}

function RemoveDialog({
  link,
  workspaces,
  onClose,
  onRemove,
}: {
  link: EnvLink;
  workspaces: number;
  onClose: () => void;
  onRemove: (wipe: boolean) => Promise<void>;
}) {
  const [wipe, setWipe] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Alert
      open
      onDismiss={onClose}
      title={`Remove ${link.name}?`}
      description={
        <>
          Removes the machine from this list; its files stay on it.
          {workspaces > 0 && ` Its ${plural(workspaces, "workspace")} leave the rail.`}
        </>
      }
      error={error}
    >
      <label className="mx-4 mb-4 flex cursor-pointer items-center gap-4 rounded-xl bg-card px-3.5 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          <span>Also delete ~/.crew</span>
          <span className="text-[12px] text-text-muted">Sessions, transcripts and routines. Can't be undone.</span>
        </span>
        <Switch checked={wipe} onChange={setWipe} />
      </label>
      <Footer>
        <Button variant="ghost" onClick={onClose}>
          Keep
        </Button>
        <Button
          variant="danger"
          loading={removing}
          onClick={() => {
            setRemoving(true);
            setError(null);
            void onRemove(wipe).then(onClose, (reason: unknown) => {
              setError(message(reason));
              setRemoving(false);
            });
          }}
        >
          Remove
        </Button>
      </Footer>
    </Alert>
  );
}

function LogsDialog({ link, onClose }: { link: EnvLink; onClose: () => void }) {
  const host = remotesHost();
  const local = link.id === LOCAL;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // Opened from a menu, focus is still back on the page: take it, so Escape reaches the dialog.
  useEffect(() => body.current?.focus(), []);
  // The newest lines are the ones that matter.
  useEffect(() => {
    const el = body.current;
    if (el && text) el.scrollTop = el.scrollHeight;
  }, [text]);

  const read = useCallback(
    () =>
      host?.logs(link.id).then(
        (next) => {
          setError(null);
          setText(next.trim() || "No log lines yet.");
        },
        (reason: unknown) => setError(message(reason)),
      ),
    [host, link.id],
  );
  useEffect(() => void read(), [read]);
  const load = () => {
    setText(null);
    setCopied(false);
    void read();
  };
  const state = stateOf(link, null, false);

  return (
    <Overlay onClose={onClose} width="w-[760px]" label={`${link.name} daemon logs`}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <ScrollTextIcon className="size-4 text-icon" />
        <span className="font-medium">{link.name}</span>
        <span className="text-[12px] text-text-muted">Logs</span>
        <span className="flex-1" />
        <Chip tone={state.tone} dot={false}>{state.label}</Chip>
      </div>
      <div ref={body} tabIndex={-1} className="min-h-40 flex-1 overflow-auto bg-canvas px-4 py-3 outline-none">
        {error ? (
          <p className="text-[12px] text-danger">{error}</p>
        ) : text === null ? (
          <p className="text-[12px] text-text-muted">{local ? "Reading the log…" : "Reading over SSH…"}</p>
        ) : (
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap" data-selectable>
            {text}
          </pre>
        )}
      </div>
      <Footer>
        <Button variant="ghost" icon={RefreshCwIcon} onClick={load}>
          Refresh
        </Button>
        <Button
          variant="ghost"
          icon={CopyIcon}
          disabled={!text}
          onClick={() => {
            if (!text) return;
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </Footer>
    </Overlay>
  );
}

/* ── Text ───────────────────────────────────────────────────────────── */

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
function ago(at: number): string {
  const seconds = Math.max(Math.round((Date.now() - at) / 1000), 0);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function memory(total: number, available: number | null | undefined): string {
  if (available == null) return bytes(total);
  return `${bytes(available)} free of ${bytes(total)}`;
}

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index] ?? "B"}`;
}
