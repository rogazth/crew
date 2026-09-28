import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpCircleIcon,
  ChevronRightIcon,
  CopyIcon,
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
  type LucideIcon as Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectionLabel, EnvTile } from "../chrome/EnvBits";
import { whereOf } from "../lib/envText";
import { Alert, Button, Field, Footer, Overlay, PANEL, ROW, TextInput, Toggle } from "../chrome/kit";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useEnvLinks } from "../hooks/useEnvLinks";
import * as api from "../lib/api";
import { LOCAL, envOf, reconnect, refreshRemotes, type EnvLink } from "../lib/client/registry";
import { remotesHost } from "../lib/host";
import { PROVIDERS } from "../lib/providers";
import { INSTALL_STEPS, compareVersions, errorText as message, type Tailnet } from "../lib/remotes";
import { openWorkspaceOn, subscribeAdd, takeAddRequest, WAKE_ON, WARN_RELAY } from "../lib/remoteUi";
import type { Workspace } from "../lib/types";
import { AddMachine } from "./AddMachine";

type Props = {
  workspaces: Workspace[];
  onOpenTerminal: (envId: string) => Promise<void>;
};

/** A daemon job running from a row's menu, shown on the row until it ends. */
type Busy = { label: string; step: string | null };

/** Settings › Environments: this Mac, each machine Crew runs on, the installer, and Tailscale. */
export function EnvironmentSettings({ workspaces, onOpenTerminal }: Props) {
  const links = useEnvLinks();
  const host = remotesHost();
  const [adding, setAdding] = useState(() => takeAddRequest());
  const [tailnet, setTailnet] = useState<Tailnet | null>(null);
  const [warnRelay, setWarnRelay] = useState(true);
  const [wake, setWake] = useState(true);
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [logs, setLogs] = useState<EnvLink | null>(null);
  const [editing, setEditing] = useState<EnvLink | null>(null);
  const [removing, setRemoving] = useState<EnvLink | null>(null);

  useEffect(() => subscribeAdd(() => setAdding(true)), []);
  useEffect(() => {
    void api.stateGet(WARN_RELAY).then((value) => setWarnRelay(value !== "off"), () => {});
    void api.stateGet(WAKE_ON).then((value) => setWake(value !== "off"), () => {});
  }, []);

  const readTailnet = useCallback(() => {
    if (!host) return;
    void host.tailnet().then(setTailnet, (reason: unknown) =>
      setTailnet({ state: "error", account: null, message: message(reason), devices: [] }),
    );
  }, [host]);
  useEffect(readTailnet, [readTailnet]);

  // Update's progress comes in step by step; the row says which one it is on.
  useEffect(() => {
    if (!host) return;
    return host.onProgress((step) => {
      setBusy((current) => {
        const job = current[step.job];
        if (!job) return current;
        const label = INSTALL_STEPS.find((item) => item.id === step.id)?.label ?? null;
        return { ...current, [step.job]: { ...job, step: step.state === "running" ? label : job.step } };
      });
    });
  }, [host]);

  const local = links.find((link) => link.id === LOCAL) ?? null;
  const remotes = links.filter((link) => link.id !== LOCAL);
  const count = (envId: string) => workspaces.filter((workspace) => envOf(workspace.id) === envId).length;

  async function run(link: EnvLink, label: string, work: () => Promise<unknown>, done?: string) {
    setNotice(null);
    setBusy((current) => ({ ...current, [link.id]: { label, step: null } }));
    try {
      await work();
      if (done) setNotice({ tone: "info", text: done });
    } catch (reason) {
      setNotice({ tone: "error", text: `${link.name}: ${message(reason)}` });
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[link.id];
        return next;
      });
    }
  }

  function actionsFor(link: EnvLink): Action[] {
    const behind = updateFor(link, local);
    return [
      { label: "Reconnect", icon: RefreshCwIcon, run: () => reconnect(link.id) },
      {
        label: behind ? `Update crewd to ${behind}` : "Reinstall crewd",
        icon: ArrowUpCircleIcon,
        disabled: !host,
        run: () => void update(link),
      },
      {
        label: "Restart daemon",
        icon: RotateCwIcon,
        disabled: !host,
        run: () =>
          void run(link, "Restarting", async () => {
            await host?.restart(link.id);
            reconnect(link.id);
          }),
      },
      {
        label: "Open workspace…",
        icon: FolderOpenIcon,
        disabled: link.status !== "online" || link.mismatch,
        run: () => openWorkspaceOn(link.id),
      },
      {
        label: "Open terminal on machine",
        icon: SquareTerminalIcon,
        disabled: link.status !== "online" || link.mismatch,
        run: () => void onOpenTerminal(link.id).catch((reason: unknown) => setNotice({ tone: "error", text: message(reason) })),
      },
      { label: "Daemon logs", icon: ScrollTextIcon, disabled: !host, run: () => setLogs(link) },
      { label: "Edit…", icon: PencilIcon, run: () => setEditing(link) },
      { label: "Remove…", icon: Trash2Icon, danger: true, disabled: !host, run: () => setRemoving(link) },
    ];
  }

  function update(link: EnvLink) {
    return run(
      link,
      "Updating",
      async () => {
        await host?.update(link.id);
        await refreshRemotes();
        reconnect(link.id);
      },
      `${link.name} runs the new crewd.`,
    );
  }

  return (
    <>
      <SettingsSection title="Machines">
        <MachineRow link={local} workspaces={local ? count(LOCAL) : 0} />
        {remotes.map((link) => (
          <MachineRow
            key={link.id}
            link={link}
            workspaces={count(link.id)}
            update={updateFor(link, local)}
            onUpdate={host ? () => void update(link) : undefined}
            relay={warnRelay && tailnet?.devices.some((device) => device.ip === link.host && device.relay) === true}
            busy={busy[link.id] ?? null}
            actions={actionsFor(link)}
            onReconnect={() => reconnect(link.id)}
          />
        ))}
      </SettingsSection>

      {notice && (
        <p className={`-mt-5 px-2.5 text-[12px] ${notice.tone === "error" ? "text-danger" : "text-text-muted"}`}>{notice.text}</p>
      )}

      {host &&
        (adding ? (
          <SettingsSection title="New machine">
            <AddMachine
              tailnet={tailnet}
              links={remotes}
              onRefresh={readTailnet}
              onCancel={() => setAdding(false)}
              onInstalled={() => {
                void refreshRemotes();
                readTailnet();
              }}
              onOpenWorkspace={(envId) => {
                setAdding(false);
                openWorkspaceOn(envId);
              }}
            />
          </SettingsSection>
        ) : (
          <div className="-mt-5 px-1">
            <Button icon={PlusIcon} onClick={() => setAdding(true)}>
              Add machine
            </Button>
          </div>
        ))}

      <SettingsSection title="Network">
        <SettingsRow label="Tailscale" description="Crew reaches every machine over your tailnet, peer to peer. No Crew server sits in between.">
          <TailnetState tailnet={tailnet} available={host !== null} />
        </SettingsRow>
        <Toggle
          label="Warn about relayed connections"
          description="Say so when a machine is only reachable through a Tailscale relay. It works, but typing lags."
          checked={warnRelay}
          onChange={(checked) => {
            setWarnRelay(checked);
            void api.stateSet(WARN_RELAY, checked ? "on" : "off");
          }}
        />
        <Toggle
          label="Reconnect on wake"
          description="Pick every machine back up the moment this Mac wakes, instead of on the next heartbeat."
          checked={wake}
          onChange={(checked) => {
            setWake(checked);
            void api.stateSet(WAKE_ON, checked ? "on" : "off");
          }}
        />
      </SettingsSection>

      {logs && <LogsDialog link={logs} onClose={() => setLogs(null)} />}
      {editing && (
        <EditDialog
          link={editing}
          onClose={() => setEditing(null)}
          onSave={async (edit) => {
            const link = editing;
            if (!link.host || link.port === null) return;
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
            setNotice(warning ? { tone: "error", text: warning } : { tone: "info", text: `${removing.name} was removed.` });
          }}
        />
      )}
    </>
  );
}

/** The newer crewd this machine could run, when this Mac's is ahead of it. */
function updateFor(link: EnvLink, local: EnvLink | null): string | null {
  if (link.mismatch) return local?.version ?? "the current version";
  if (!local?.version || !link.version) return null;
  return compareVersions(link.version, local.version) < 0 ? local.version : null;
}

type Action = { label: string; icon: Icon; run: () => void; disabled?: boolean; danger?: boolean };

function MachineRow({
  link,
  workspaces,
  update = null,
  onUpdate,
  relay = false,
  busy = null,
  actions,
  onReconnect,
}: {
  link: EnvLink | null;
  workspaces: number;
  update?: string | null;
  onUpdate?: (() => void) | undefined;
  relay?: boolean;
  busy?: Busy | null;
  actions?: Action[];
  onReconnect?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!link) {
    return (
      <div className="flex min-h-14 items-center gap-3 py-2.5 text-text-muted">
        <EnvTile link={null} />
        Starting the daemon…
      </div>
    );
  }
  const local = link.id === LOCAL;
  const info = link.info;
  const facts = [
    local ? (info?.hostname ?? null) : whereOf(link),
    info?.os ?? null,
    link.version ? `crewd ${link.version}` : null,
    plural(workspaces, "workspace"),
  ].filter(Boolean);
  const down = !local && link.status === "offline";
  return (
    <div className="flex flex-col gap-2 py-2.5">
      <div className="flex min-h-9 items-center gap-3">
        <EnvTile link={link} />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="group flex min-w-0 flex-1 items-center gap-1 text-left outline-none"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate">{link.name}</span>
              <ChevronRightIcon
                aria-hidden
                className={`size-3.5 shrink-0 text-placeholder transition-transform group-hover:text-icon ${open ? "rotate-90" : ""}`}
              />
            </span>
            <span className="block truncate text-[12px] text-text-muted">
              {facts.map((fact, index) => (
                <span key={fact}>
                  {index > 0 && " · "}
                  {index === 0 && !local ? <span className="font-mono text-[11.5px]">{fact}</span> : fact}
                </span>
              ))}
            </span>
          </span>
        </button>
        {update && onUpdate && !busy && (
          <button
            type="button"
            onClick={onUpdate}
            className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-info/12 px-2 text-[11px] font-medium text-info hover:bg-info/20"
          >
            <ArrowUpCircleIcon className="size-3" />
            Update {link.version ? `${link.version} → ` : ""}
            {update}
          </button>
        )}
        {busy ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-muted">
            <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
            {busy.step ?? busy.label}…
          </span>
        ) : local ? (
          <span className="shrink-0 text-[12px] text-text-muted">Started with Crew</span>
        ) : (
          <ConnectionLabel link={link} relay={relay} />
        )}
        {actions && <MachineMenu link={link} actions={actions} />}
      </div>
      {down && link.error && (
        <Callout tone="danger">
          <span className="min-w-0 flex-1">
            <b className="font-medium">Can't reach {link.name}.</b> <span className="text-text-muted">{link.error}</span>
          </span>
          {onReconnect && (
            <Button variant="ghost" className="-my-1 h-6 px-2 text-[12px]" onClick={onReconnect}>
              Try again
            </Button>
          )}
        </Callout>
      )}
      {link.mismatch && (
        <Callout tone="warning">
          <span>
            <b className="font-medium">{link.name} runs a crewd this app can't talk to.</b>{" "}
            <span className="text-text-muted">Update it to open its workspaces.</span>
          </span>
        </Callout>
      )}
      {relay && link.status === "online" && (
        <Callout tone="warning">
          <span>
            <b className="font-medium">{link.name} goes through a Tailscale relay.</b>{" "}
            <span className="text-text-muted">
              Typing in its terminals will lag. Open UDP 41641 on that network, or use a peer relay, to get a direct path.
            </span>
          </span>
        </Callout>
      )}
      {open && <Health link={link} />}
    </div>
  );
}

function Callout({ tone, children }: { tone: "danger" | "warning"; children: ReactNode }) {
  return (
    <div
      className={`ml-11 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] ${tone === "danger" ? "bg-danger/8" : "bg-warning/10"}`}
    >
      <TriangleAlertIcon className={`mt-0.5 size-3.5 shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"}`} />
      {children}
    </div>
  );
}

/** What the daemon reports about its machine: the agent CLIs it found, load and memory. */
function Health({ link }: { link: EnvLink }) {
  const info = link.info;
  if (!info) {
    return <p className="ml-11 text-[12px] text-text-muted">Details show once {link.name} is connected.</p>;
  }
  const installed = new Set(info.installed);
  return (
    <dl className="ml-11 grid grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-2 rounded-lg bg-canvas px-3 py-2.5 text-[12px] ring-1 ring-hairline">
      <dt className="text-text-muted">Agent CLIs</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        {PROVIDERS.map((provider) => {
          const found = installed.has(provider.binary);
          return (
            <span
              key={provider.id}
              title={found ? provider.binary : `${provider.binary} isn't installed there`}
              className={`flex h-6 items-center gap-1.5 rounded-md px-1.5 ring-1 ring-hairline ${found ? "" : "opacity-40"}`}
            >
              <ProviderIcon provider={provider.id} className="size-3.5" />
              {provider.label}
            </span>
          );
        })}
      </dd>
      <dt className="text-text-muted">Agents running</dt>
      <dd>{info.agentsRunning}</dd>
      <dt className="text-text-muted">Load</dt>
      <dd className="tabular-nums">
        {info.load.toFixed(2)} <span className="text-text-muted">on {plural(info.cpus, "core")}</span>
      </dd>
      <dt className="text-text-muted">Memory</dt>
      <dd className="tabular-nums">{memory(info.memoryTotal, info.memoryAvailable)}</dd>
      <dt className="text-text-muted">Home</dt>
      <dd className="truncate font-mono text-[11.5px]">{info.home}</dd>
      {link.id !== LOCAL && (
        <>
          <dt className="text-text-muted">SSH</dt>
          <dd className="font-mono text-[11.5px]">ssh {whereOf(link)}</dd>
          <dt className="text-text-muted">Address</dt>
          <dd className="font-mono text-[11.5px]">
            {link.host}:{link.port}
            {info.socksPort ? <span className="text-text-muted"> · browser proxy on {info.socksPort}</span> : null}
          </dd>
        </>
      )}
    </dl>
  );
}

function MachineMenu({ link, actions }: { link: EnvLink; actions: Action[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`${link.name} actions`}
        className="grid size-7 shrink-0 place-items-center rounded-md text-icon outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-hover"
      >
        <EllipsisIcon className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            {actions.map((action) => (
              <div key={action.label}>
                {action.danger && <Menu.Separator className="my-1 h-px bg-hairline" />}
                <Menu.Item
                  disabled={action.disabled ?? false}
                  onClick={action.run}
                  className={`${ROW} data-disabled:opacity-40 ${action.danger ? "text-danger" : ""}`}
                >
                  <action.icon className="size-4 shrink-0 opacity-80" />
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
  const running = tailnet.state === "running";
  return (
    <span className="flex max-w-64 items-center gap-1.5 text-[12px] text-text-muted">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${running ? "bg-success" : "bg-danger"}`} />
      <span className="truncate">{running ? `Connected${tailnet.account ? ` · ${tailnet.account}` : ""}` : (tailnet.message ?? "Not running")}</span>
    </span>
  );
}

function LogsDialog({ link, onClose }: { link: EnvLink; onClose: () => void }) {
  const host = remotesHost();
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
    void read();
  };

  return (
    <Overlay onClose={onClose} width="w-[760px]" label={`${link.name} daemon logs`}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <ScrollTextIcon className="size-4 text-icon" />
        <span className="font-medium">{link.name}</span>
        <span className="text-text-muted">journalctl --user -u crewd</span>
        <span className="flex-1" />
        <ConnectionLabel link={link} />
      </div>
      <div ref={body} tabIndex={-1} className="min-h-40 flex-1 overflow-auto bg-canvas px-4 py-3 outline-none">
        {error ? (
          <p className="text-[12px] text-danger">{error}</p>
        ) : text === null ? (
          <p className="text-[12px] text-text-muted">Reading over SSH…</p>
        ) : (
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-text">{text}</pre>
        )}
      </div>
      <Footer hints={[["esc", "Close"]]}>
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
      onClose();
    } catch (reason) {
      setError(message(reason));
      setSaving(false);
    }
  }
  return (
    <Alert open onDismiss={onClose} title={`Edit ${link.name}`} description="crewd keeps listening on its tailnet address; SSH is only for installing, updating and logs." error={error}>
      <form
        className="flex flex-col gap-3 px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Name" hint="How the rail, ⌘O and notifications call it.">
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
      <Footer hints={[["↩", "Save"], ["esc", "Cancel"]]}>
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
          Crew stops crewd there and forgets the machine here.
          {workspaces > 0 && ` Its ${plural(workspaces, "workspace")} leave the rail; the folders stay on the machine.`}
        </>
      }
      error={error}
    >
      <div className="mx-4 mb-3 rounded-lg bg-card px-3">
        <Toggle
          label="Also delete ~/.crew there"
          description="Sessions, transcripts and routines stored on that machine. Can't be undone."
          checked={wipe}
          onChange={setWipe}
        />
      </div>
      <Footer hints={[["esc", "Cancel"]]}>
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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function memory(total: number, available: number | null | undefined): string {
  if (available == null) return `${bytes(total)}`;
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
