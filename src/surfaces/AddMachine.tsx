import {
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MonitorIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SquareTerminalIcon as TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Field, TextInput } from "../chrome/kit";
import type { EnvLink } from "../lib/client/registry";
import { remotesHost } from "../lib/host";
import { PROVIDERS } from "../lib/providers";
import {
  DEFAULT_PORT,
  INSTALL_JOB,
  INSTALL_STEPS,
  errorText,
  type InstallStep,
  type InstallStepId,
  type RemoteEnv,
  type SshHost,
  type Tailnet,
  type TailscaleDevice,
} from "../lib/remotes";

const OTHER = "other";

type Stage = "form" | "installing" | "failed" | "done";

type Props = {
  tailnet: Tailnet | null;
  /** Machines already in Crew, so their SSH hosts read as added. */
  links: EnvLink[];
  onRefresh: () => void;
  onCancel: () => void;
  onInstalled: (env: RemoteEnv) => void;
  onOpenWorkspace: (envId: string) => void;
};

/** What the form will hand ssh, and how it reads. */
type Pick = { key: string; destination: string; label: string; user: string; via: SshHost | null };

/**
 * Adding a machine: pick it off the tailnet or from ~/.ssh/config (or type
 * where it is), and Crew signs in with the system's ssh, installs crewd as a
 * user service and pairs with it over Tailscale.
 */
export function AddMachine({ tailnet, links, onRefresh, onCancel, onInstalled, onOpenWorkspace }: Props) {
  const host = remotesHost();
  const devices = tailnet?.devices ?? [];
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [user, setUser] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [stage, setStage] = useState<Stage>("form");
  const [steps, setSteps] = useState<Partial<Record<InstallStepId, InstallStep>>>({});
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<RemoteEnv | null>(null);

  useEffect(() => {
    void host?.sshHosts().then(setSshHosts, () => {});
  }, [host]);

  useEffect(() => {
    if (!host) return;
    return host.onProgress((step) => {
      if (step.job === INSTALL_JOB) setSteps((current) => ({ ...current, [step.id]: step }));
    });
  }, [host]);

  // A tailnet machine is reached through the user's own Host for it, when there is one.
  const aliasOf = (device: TailscaleDevice) =>
    sshHosts.find((item) => [device.ip, device.dns, device.host].includes(item.hostname) || item.alias === device.host) ?? null;
  const matched = new Set(devices.map(aliasOf).filter((item): item is SshHost => item !== null).map((item) => item.alias));
  const configHosts = sshHosts.filter((item) => !matched.has(item.alias));
  const addedSsh = new Set(links.flatMap((link) => [link.ssh, link.host].filter((value): value is string => !!value)));
  const sshReason = (item: SshHost) => (addedSsh.has(item.alias) || addedSsh.has(item.hostname) ? "Added" : null);

  const picks: Pick[] = [
    ...devices
      .filter((device) => device.reason === null)
      .map((device) => {
        const via = aliasOf(device);
        return { key: `tailnet:${device.ip}`, destination: via?.alias ?? device.ip, label: device.host, user: via?.user ?? "", via };
      }),
    ...configHosts
      .filter((item) => sshReason(item) === null)
      .map((item) => ({ key: `ssh:${item.alias}`, destination: item.alias, label: item.alias, user: item.user, via: item })),
  ];
  const typed: Pick = { key: OTHER, destination: other.trim(), label: other.trim(), user: "", via: null };
  // Until something is picked, the first machine that can be added is.
  const choice = picked ?? picks[0]?.key ?? OTHER;
  const current = choice === OTHER ? typed : (picks.find((item) => item.key === choice) ?? typed);
  const shownName = name ?? current.label;

  const portNumber = Number(port);
  const portOk = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65535;
  const ready = current.destination.length > 0 && shownName.trim().length > 0 && portOk;

  function pick(key: string) {
    setPicked(key);
    setName(null);
    setUser("");
  }

  async function install() {
    if (!host || !ready) return;
    setStage("installing");
    setSteps({});
    setError(null);
    try {
      const env = await host.install({ name: shownName.trim(), ssh: current.destination, user: user.trim(), port: portNumber });
      setCreated(env);
      setStage("done");
      onInstalled(env);
    } catch (reason) {
      setError(errorText(reason));
      setStage("failed");
    }
  }

  if (stage === "done" && created) {
    return <Ready env={created} clis={steps.clis?.detail ?? ""} onOpenWorkspace={() => onOpenWorkspace(created.id)} onClose={onCancel} />;
  }

  if (stage !== "form") {
    return (
      <div className="flex flex-col gap-4 py-4">
        <p className="text-text-muted">
          Setting up <span className="font-medium text-text">{shownName}</span> through{" "}
          <span className="font-mono text-[12px] text-text">ssh {current.destination}</span>. Nothing is installed outside ~/.crew
          and ~/.config/systemd/user on that machine.
        </p>
        <Progress steps={steps} failed={stage === "failed"} />
        {stage === "failed" && (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[12px] break-words text-danger">{error}</p>
            <Button variant="ghost" onClick={() => setStage("form")}>
              Back
            </Button>
            <Button variant="primary" icon={RefreshCwIcon} onClick={() => void install()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-muted">
          Machine
          <span className="flex-1" />
          {tailnet?.state === "running" && (
            <span className="flex items-center gap-1 font-normal">
              <ShieldCheckIcon className="size-3.5 text-success" />
              Tailscale{tailnet.account ? ` · ${tailnet.account}` : ""}
            </span>
          )}
          <button
            type="button"
            aria-label="Look again"
            title="Look again"
            onClick={() => {
              onRefresh();
              void host?.sshHosts().then(setSshHosts, () => {});
            }}
            className="grid size-6 place-items-center rounded-md text-icon hover:bg-hover hover:text-text"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        </div>
        <div role="radiogroup" aria-label="Machine" className="flex max-h-80 flex-col overflow-y-auto rounded-lg bg-canvas ring-1 ring-hairline">
          <Group label="On your tailnet" first />
          {tailnet === null && <p className="px-3 py-2.5 text-text-muted">Asking Tailscale…</p>}
          {tailnet && tailnet.state !== "running" && (
            <p className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-text-muted">
              <CircleAlertIcon className="size-3.5 shrink-0 text-warning" />
              {tailnet.message ?? "Tailscale is not running"}.
            </p>
          )}
          {devices.map((item) => {
            const via = aliasOf(item);
            return (
              <MachineRow
                key={item.ip}
                glyph={glyphOf(item.os)}
                title={item.host}
                detail={item.ip}
                via={via && via.alias !== item.host ? `ssh ${via.alias}` : null}
                relay={item.relay && item.reason === null}
                note={item.reason ?? item.os}
                disabled={item.reason !== null}
                on={choice === `tailnet:${item.ip}`}
                onPick={() => pick(`tailnet:${item.ip}`)}
              />
            );
          })}
          {configHosts.length > 0 && <Group label="From ~/.ssh/config" />}
          {configHosts.map((item) => {
            const reason = sshReason(item);
            return (
              <MachineRow
                key={item.alias}
                glyph={TerminalIcon}
                title={item.alias}
                detail={`${item.user}@${item.hostname}${item.port !== 22 ? `:${item.port}` : ""}`}
                via={null}
                relay={false}
                note={reason ?? "SSH"}
                disabled={reason !== null}
                on={choice === `ssh:${item.alias}`}
                onPick={() => pick(`ssh:${item.alias}`)}
              />
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={choice === OTHER}
            onClick={() => pick(OTHER)}
            className={`flex h-9 shrink-0 items-center gap-2.5 border-t border-hairline px-3 text-left transition-colors ${
              choice === OTHER ? "bg-selected" : "hover:bg-hover"
            }`}
          >
            <Radio on={choice === OTHER} />
            <span className="text-text-muted">Another address…</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_1fr_6.5rem] gap-3">
        {choice === OTHER && (
          <Field label="Address" hint="Anything ssh takes: a Host from ~/.ssh/config, a tailnet IP, a name." className="col-span-3">
            <TextInput
              value={other}
              onChange={(event) => setOther(event.target.value)}
              placeholder="falcon or 100.64.0.12"
              autoFocus
              className="font-mono text-[12.5px]"
            />
          </Field>
        )}
        <Field label="Name" hint="How the rail and ⌘O call it.">
          <TextInput value={shownName} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="SSH user" hint={current.user ? "Blank uses the one ~/.ssh/config sets." : "Blank uses ~/.ssh/config, or your Mac login."}>
          <TextInput value={user} onChange={(event) => setUser(event.target.value)} placeholder={current.user || "ubuntu"} />
        </Field>
        <Field label="Port" error={portOk ? null : "1 to 65534"} hint={`Proxy on ${portOk ? portNumber + 1 : "the next"}`}>
          <TextInput value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" className="tabular-nums" />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[12px] text-text-muted">
          Crew signs in with your ssh and its config, and runs crewd there as a user service, reached over Tailscale. Agents keep
          working while this Mac sleeps.
        </p>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready} onClick={() => void install()}>
          {current.label ? `Install on ${current.label}` : "Install"}
        </Button>
      </div>
    </div>
  );
}

function Group({ label, first = false }: { label: string; first?: boolean }) {
  return (
    <div className={`px-3 pt-2 pb-1 text-[11px] font-medium text-text-muted ${first ? "" : "border-t border-hairline"}`}>{label}</div>
  );
}

function glyphOf(os: string): typeof ServerIcon {
  if (os === "iOS" || os === "Android") return SmartphoneIcon;
  if (os === "macOS" || os === "Windows") return MonitorIcon;
  return ServerIcon;
}

function Radio({ on }: { on: boolean }) {
  return (
    <span className={`grid size-3.5 shrink-0 place-items-center rounded-full ring-1 ${on ? "bg-accent ring-accent" : "ring-border-strong"}`}>
      {on && <span className="size-1.5 rounded-full bg-inverse" />}
    </span>
  );
}

function MachineRow({
  glyph: Glyph,
  title,
  detail,
  via,
  relay,
  note,
  disabled,
  on,
  onPick,
}: {
  glyph: typeof ServerIcon;
  title: string;
  detail: string;
  via: string | null;
  relay: boolean;
  note: string;
  disabled: boolean;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onPick}
      className={`flex h-9 shrink-0 items-center gap-2.5 border-t border-hairline px-3 text-left transition-colors first-of-type:border-t-0 disabled:cursor-default ${
        on ? "bg-selected" : disabled ? "" : "hover:bg-hover"
      }`}
    >
      <Radio on={on} />
      <Glyph className={`size-4 shrink-0 ${disabled ? "text-placeholder" : "text-icon"}`} />
      <span className={`truncate font-mono text-[12.5px] ${disabled ? "text-placeholder" : ""}`}>{title}</span>
      <span className="truncate font-mono text-[11px] text-placeholder">{detail}</span>
      {via && <span className="shrink-0 rounded bg-card px-1.5 font-mono text-[10.5px] text-text-muted ring-1 ring-hairline">{via}</span>}
      <span className="flex-1" />
      {relay && <span className="text-[11px] text-warning">Relay</span>}
      <span className="shrink-0 text-[11px] text-text-muted">{note}</span>
    </button>
  );
}

function Progress({ steps, failed }: { steps: Partial<Record<InstallStepId, InstallStep>>; failed: boolean }) {
  return (
    <ol className="flex flex-col">
      {INSTALL_STEPS.map((step, index) => {
        const current = steps[step.id];
        const state = current?.state ?? (failed ? "skipped" : "todo");
        const last = index === INSTALL_STEPS.length - 1;
        return (
          <li key={step.id} className="relative flex gap-3 pb-3 last:pb-0">
            {!last && <span className={`absolute top-5 bottom-0 left-[9px] w-px ${state === "done" ? "bg-text/30" : "bg-hairline"}`} />}
            <span
              className={`relative z-[1] grid size-[19px] shrink-0 place-items-center rounded-full ${
                state === "done"
                  ? "bg-accent text-inverse"
                  : state === "error"
                    ? "bg-danger text-white"
                    : state === "running"
                      ? "bg-canvas ring-1 ring-border-strong"
                      : "bg-canvas ring-1 ring-hairline"
              }`}
            >
              {state === "done" && <CheckIcon className="size-3 stroke-3" />}
              {state === "error" && <XIcon className="size-3 stroke-3" />}
              {state === "running" && <LoaderCircleIcon className="size-3 animate-spin text-text-muted" />}
            </span>
            <span className="flex min-w-0 flex-col pt-px">
              <span className={state === "todo" || state === "skipped" ? "text-text-muted" : ""}>{step.label}</span>
              {current?.detail && (
                <span className={`font-mono text-[11px] break-words ${state === "error" ? "text-danger" : "text-text-muted"}`}>
                  {current.detail}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Ready({ env, clis, onOpenWorkspace, onClose }: { env: RemoteEnv; clis: string; onOpenWorkspace: () => void; onClose: () => void }) {
  const found = new Set(clis === "none found" ? [] : clis.split(",").map((item) => item.trim()).filter(Boolean));
  const missing = PROVIDERS.filter((provider) => !found.has(provider.binary)).map((provider) => provider.binary);
  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-center gap-3 rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-hairline">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-success/15 text-success">
          <CheckIcon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{env.name} is ready</span>
          <span className="flex items-center gap-1 text-[12px] text-text-muted">
            {missing.length === 0 ? (
              "Every agent CLI Crew knows is installed there."
            ) : found.size === 0 ? (
              <>
                <CircleAlertIcon className="size-3 shrink-0 text-warning" /> No agent CLI found. Install one there and sign in to it.
              </>
            ) : (
              <>
                <CircleAlertIcon className="size-3 shrink-0 text-warning" /> Found {[...found].join(", ")}. Not found: {missing.join(", ")}.
              </>
            )}
          </span>
        </span>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        <Button variant="primary" onClick={onOpenWorkspace}>
          Open workspace
        </Button>
      </div>
    </div>
  );
}
