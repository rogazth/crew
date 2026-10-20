// Adding a machine, as a guided dialog in three steps:
// how to reach it (a Host from ~/.ssh/config, a tailnet device, or an address
// typed in), the setup walking live through the backend's own steps (reach,
// sign in, look for a crewd, upload, service, pair, agent CLIs) with a clear
// way past each failure, then its name. The dialog keeps one size through
// every step. Everything here is real: ~/.ssh/config and Tailscale are read on
// open, and the install is `remotesHost().install` with its progress events.
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileCode2Icon,
  KeyboardIcon,
  LaptopIcon,
  LoaderCircleIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TerminalIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Field, IconButton, Overlay, TextInput } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useEnvLinks } from "../../hooks/useEnvLinks";
import * as api from "../../lib/api";
import { refreshRemotes } from "../../lib/client/registry";
import { remotesHost } from "../../lib/host";
import { PROVIDERS } from "../../lib/providers";
import {
  DEFAULT_PORT,
  INSTALL_JOB,
  INSTALL_STEPS,
  errorText,
  type InstallFailure,
  type InstallStep,
  type InstallStepId,
  type RemoteEnv,
  type SshHost,
  type Tailnet,
  type TailscaleDevice,
} from "../../lib/remotes";
import { openWorkspaceOn } from "../../lib/remoteUi";
import { manageProviders } from "./route";
import { CopyButton, ProgressBar } from "./ui";

type Via = "ssh" | "tailnet" | "manual";
type Stage = "connect" | "setup" | "name" | "done";

const STAGES: { id: Exclude<Stage, "done">; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "setup", label: "Set up" },
  { id: "name", label: "Name" },
];

/** A machine the first step can offer, and why not when it can't. */
type Choice = {
  key: string;
  via: Via;
  title: string;
  detail: string;
  note: string | null;
  blocked: string | null;
  /** What `ssh` is given. */
  destination: string;
  /** The user ~/.ssh/config sets for it, when there is a Host for it. */
  user: string;
  /** The SSH port ~/.ssh/config sets for it. */
  sshPort: number | null;
  /** The name the machine gets until it is named. */
  label: string;
  icon: LucideIcon;
  relay?: boolean;
  /** "ssh falcon": the Host in ~/.ssh/config this tailnet device is reached through. */
  alias?: string;
};

type Advanced = { user: string; sshPort: string; port: string };

const FRESH: Advanced = { user: "", sshPort: "", port: String(DEFAULT_PORT) };

type Steps = Partial<Record<InstallStepId, InstallStep>>;

function glyphOf(os: string): LucideIcon {
  if (os === "iOS" || os === "Android") return SmartphoneIcon;
  if (os === "macOS" || os === "Windows") return LaptopIcon;
  return ServerIcon;
}

export function AddMachineFlow({ onClose }: { onClose: () => void }) {
  const host = remotesHost();
  const links = useEnvLinks();
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [tailnet, setTailnet] = useState<Tailnet | null>(null);
  const [via, setVia] = useState<Via>("ssh");
  const [picked, setPicked] = useState<Record<Via, string | null>>({ ssh: null, tailnet: null, manual: null });
  const [address, setAddress] = useState("");
  const [advanced, setAdvanced] = useState<Advanced>(FRESH);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [stage, setStage] = useState<Stage>("connect");
  const [steps, setSteps] = useState<Steps>({});
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [created, setCreated] = useState<RemoteEnv | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Which install the events and results belong to; Back makes the running one stale.
  const run = useRef(0);
  const running = useRef(false);

  const load = useCallback(() => {
    if (!host) return;
    void host.tailnet().then(setTailnet, (reason: unknown) =>
      setTailnet({ state: "error", account: null, message: errorText(reason), devices: [] }),
    );
    void host.sshHosts().then(setSshHosts, () => {});
  }, [host]);
  useEffect(load, [load]);
  const look = () => {
    setTailnet(null);
    load();
  };

  useEffect(() => {
    if (!host) return;
    return host.onProgress((step) => {
      if (step.job === INSTALL_JOB) setSteps((current) => ({ ...current, [step.id]: step }));
    });
  }, [host]);

  // Closing in the middle of an install stops it.
  useEffect(
    () => () => {
      if (running.current) void host?.cancelInstall().catch(() => {});
    },
    [host],
  );

  const devices = tailnet?.devices ?? [];
  // A tailnet machine is reached through the user's own Host for it, when there is one.
  const aliasOf = (device: TailscaleDevice) =>
    sshHosts.find((item) => [device.ip, device.dns, device.host].includes(item.hostname) || item.alias === device.host) ?? null;
  const matched = new Set(devices.map(aliasOf).filter((item): item is SshHost => item !== null).map((item) => item.alias));
  const added = new Set(links.flatMap((link) => [link.ssh, link.host].filter((value): value is string => !!value)));
  const isAdded = (...values: string[]) => values.some((value) => added.has(value));

  const sshChoices: Choice[] = sshHosts
    .filter((item) => !matched.has(item.alias))
    .map((item) => ({
      key: `ssh:${item.alias}`,
      via: "ssh",
      title: item.alias,
      detail: `${item.user}@${item.hostname}${item.port !== 22 ? `:${item.port}` : ""}`,
      note: null,
      blocked: isAdded(item.alias, item.hostname) ? "Added" : null,
      destination: item.alias,
      user: item.user,
      sshPort: item.port,
      label: item.alias,
      icon: TerminalIcon,
    }));
  const tailnetChoices: Choice[] = devices.map((device) => {
    const alias = aliasOf(device);
    return {
      key: `tailnet:${device.ip}`,
      via: "tailnet",
      title: device.host,
      detail: device.ip,
      note: device.os,
      blocked: device.reason ?? (isAdded(device.ip, device.host, alias?.alias ?? "") ? "Added" : null),
      destination: alias?.alias ?? device.ip,
      user: alias?.user ?? "",
      sshPort: alias?.port ?? null,
      label: device.host,
      icon: glyphOf(device.os),
      relay: device.relay && device.reason === null,
      ...(alias && alias.alias !== device.host ? { alias: alias.alias } : {}),
    };
  });
  const list = via === "ssh" ? sshChoices : tailnetChoices;
  const firstFree = list.find((choice) => !choice.blocked)?.key ?? null;
  const chosenKey = via === "manual" ? null : (picked[via] ?? firstFree);
  const typed = address.trim();
  const chosen: Choice | null =
    via === "manual"
      ? typed
        ? {
            key: "manual",
            via: "manual",
            title: typed,
            detail: "",
            note: null,
            blocked: null,
            destination: typed,
            user: "",
            sshPort: null,
            label: typed,
            icon: KeyboardIcon,
          }
        : null
      : (list.find((choice) => choice.key === chosenKey) ?? null);

  const portNumber = Number(advanced.port);
  const portOk = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65535;
  const sshPortOk = advanced.sshPort === "" || (/^\d+$/.test(advanced.sshPort) && Number(advanced.sshPort) > 0 && Number(advanced.sshPort) < 65536);
  const ready = chosen !== null && portOk && sshPortOk;

  const choose = (nextVia: Via, key: string | null) => {
    setPicked((current) => ({ ...current, [nextVia]: key }));
    // Overrides belong to the machine they were typed for.
    setAdvanced((current) => ({ ...current, user: "", sshPort: "" }));
  };

  const failure: InstallFailure | null =
    error === null
      ? null
      : (Object.values(steps).find((step) => step.state === "error")?.failure ?? { code: "other", message: error, hint: "" });

  const start = () => {
    if (!host || !chosen || !ready) return;
    const mine = ++run.current;
    running.current = true;
    setStage("setup");
    setSteps({});
    setError(null);
    setCreated(null);
    // Named at the end; until then it goes by its host.
    const derived = suggestName(chosen.label);
    host
      .install({
        name: derived,
        ssh: chosen.destination,
        user: advanced.user.trim(),
        port: portNumber,
        ...(advanced.sshPort ? { sshPort: Number(advanced.sshPort) } : {}),
      })
      .then(
        (env) => {
          if (mine !== run.current) return;
          running.current = false;
          setCreated(env);
          setName(env.name);
          void refreshRemotes();
        },
        (reason: unknown) => {
          if (mine !== run.current) return;
          running.current = false;
          setError(errorText(reason));
        },
      );
  };

  const stop = async () => {
    run.current += 1;
    if (running.current) {
      running.current = false;
      setCancelling(true);
      await host?.cancelInstall().catch(() => {});
      setCancelling(false);
    }
  };

  const back = async () => {
    await stop();
    setStage("connect");
    setSteps({});
    setError(null);
  };

  const close = () => {
    void stop();
    onClose();
  };

  const finish = async () => {
    if (!created) return;
    const next = name.trim();
    setSaveError(null);
    if (next && next !== created.name) {
      setSaving(true);
      try {
        const renamed = await api.upsertRemote({ ...created, name: next });
        setCreated(renamed);
        await refreshRemotes();
      } catch (reason) {
        setSaveError(errorText(reason));
        return;
      } finally {
        setSaving(false);
      }
    }
    setStage("done");
  };

  const at = stage === "done" ? STAGES.length : STAGES.findIndex((s) => s.id === stage);
  const found = foundClis(steps);
  const missing = PROVIDERS.filter((provider) => !found.includes(provider.binary));
  const where = chosen ? `${advanced.user.trim() ? `${advanced.user.trim()}@` : ""}${chosen.destination}` : "";

  return (
    <Overlay onClose={close} width="w-[620px]" label="Add a machine">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline pr-2.5 pl-5">
        <h2 className="text-[14px] font-semibold">Add a machine</h2>
        <span className="flex-1" />
        <Stepper at={at} />
        <IconButton icon={XIcon} label="Close" className="ml-2 size-7" onClick={close} />
      </div>

      <div className="h-[480px] overflow-y-auto px-5 py-4">
        {!host && <p className="text-text-muted">Adding a machine needs the Crew app.</p>}
        {host && stage === "connect" && (
          <ConnectStep
            via={via}
            onVia={setVia}
            choices={list}
            chosenKey={chosenKey}
            onPick={(key) => choose(via, key)}
            address={address}
            onAddress={setAddress}
            tailnet={tailnet}
            sshCount={sshChoices.length}
            onLook={look}
            chosen={chosen}
            advanced={advanced}
            onAdvanced={setAdvanced}
            showAdvanced={showAdvanced}
            onShowAdvanced={setShowAdvanced}
            portOk={portOk}
            sshPortOk={sshPortOk}
          />
        )}
        {stage === "setup" && <SetupStepView where={where} steps={steps} failure={failure} />}
        {stage === "name" && created && (
          <NameStep name={name} onName={setName} env={created} steps={steps} found={found} error={saveError} onSubmit={() => void finish()} />
        )}
        {stage === "done" && created && <DoneStep name={created.name} found={found} warning={steps.service?.detail ?? null} />}
      </div>

      <div className="flex h-14 shrink-0 items-center gap-2 border-t border-hairline px-4">
        {stage === "connect" && (
          <>
            <p className="min-w-0 flex-1 truncate text-[12px] text-text-muted">Uses your SSH keys. Reaches crewd over Tailscale.</p>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!host || !ready} onClick={start}>
              Connect
              <ArrowRightIcon className="size-4" />
            </Button>
          </>
        )}
        {stage === "setup" && (
          <>
            <Button variant="ghost" icon={ArrowLeftIcon} disabled={cancelling} onClick={() => void back()}>
              {created || failure ? "Back" : cancelling ? "Cancelling…" : "Cancel"}
            </Button>
            <span className="flex-1" />
            {failure ? (
              <Button variant="primary" icon={RefreshCwIcon} onClick={start}>
                Try again
              </Button>
            ) : (
              <Button variant="primary" disabled={!created} onClick={() => setStage("name")}>
                {created ? "Continue" : "Setting up…"}
                {created && <ArrowRightIcon className="size-4" />}
              </Button>
            )}
          </>
        )}
        {stage === "name" && (
          <>
            <Button variant="ghost" icon={ArrowLeftIcon} onClick={() => setStage("setup")}>
              Back
            </Button>
            <span className="flex-1" />
            <Button variant="primary" disabled={!name.trim() || saving} onClick={() => void finish()}>
              {saving ? "Saving…" : "Add machine"}
            </Button>
          </>
        )}
        {stage === "done" && created && (
          <>
            <span className="flex-1" />
            <Button
              variant="ghost"
              onClick={() => {
                onClose();
                openWorkspaceOn(created.id);
              }}
            >
              Open workspace…
            </Button>
            {missing.length > 0 && (
              <Button
                onClick={() => {
                  onClose();
                  manageProviders(created.id);
                }}
              >
                Install agents
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )}
      </div>
    </Overlay>
  );
}

/** The host part of an address, as the name a machine gets until it is named. */
function suggestName(title: string): string {
  return title.split(".")[0]!.replace(/^\d+$/, "machine");
}

/** The agent CLIs the last step found, by binary. */
function foundClis(steps: Steps): string[] {
  const detail = steps.clis?.detail ?? "";
  return detail === "" || detail === "none found" ? [] : detail.split(",").map((item) => item.trim()).filter(Boolean);
}

/* ── Stepper ────────────────────────────────────────────────────────── */

function Stepper({ at }: { at: number }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Steps">
      {STAGES.map((s, index) => {
        const done = index < at;
        const now = index === at;
        return (
          <li key={s.id} className="flex items-center gap-1.5">
            {index > 0 && <span className={`h-px w-4 ${done || now ? "bg-text/25" : "bg-hairline"}`} />}
            <span
              aria-current={now ? "step" : undefined}
              className={`flex h-6 items-center gap-1.5 rounded-full pr-2.5 pl-1 text-[12px] ${now ? "bg-accent/10 text-accent" : done ? "text-text" : "text-text-muted"}`}
            >
              <span
                className={`grid size-4 place-items-center rounded-full text-[10px] font-semibold ${
                  done ? "bg-accent text-inverse" : now ? "bg-accent text-inverse" : "ring-1 ring-border-strong"
                }`}
              >
                {done ? <CheckIcon className="size-2.5" strokeWidth={3} /> : index + 1}
              </span>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ── 1. Connect ─────────────────────────────────────────────────────── */

function ConnectStep({
  via,
  onVia,
  choices,
  chosenKey,
  onPick,
  address,
  onAddress,
  tailnet,
  sshCount,
  onLook,
  chosen,
  advanced,
  onAdvanced,
  showAdvanced,
  onShowAdvanced,
  portOk,
  sshPortOk,
}: {
  via: Via;
  onVia: (via: Via) => void;
  choices: Choice[];
  chosenKey: string | null;
  onPick: (key: string) => void;
  address: string;
  onAddress: (address: string) => void;
  tailnet: Tailnet | null;
  sshCount: number;
  onLook: () => void;
  chosen: Choice | null;
  advanced: Advanced;
  onAdvanced: (next: Advanced) => void;
  showAdvanced: boolean;
  onShowAdvanced: (show: boolean) => void;
  portOk: boolean;
  sshPortOk: boolean;
}) {
  const vias: { id: Via; label: string; line: string; icon: LucideIcon }[] = [
    { id: "ssh", label: "SSH config", line: `${sshCount} host${sshCount === 1 ? "" : "s"}`, icon: FileCode2Icon },
    {
      id: "tailnet",
      label: "Tailscale",
      line:
        tailnet === null
          ? "Asking…"
          : tailnet.state === "running"
            ? `${tailnet.devices.length} device${tailnet.devices.length === 1 ? "" : "s"}`
            : tailnet.state === "missing"
              ? "Not installed"
              : "Not running",
      icon: NetworkIcon,
    },
    { id: "manual", label: "Address", line: "Enter manually", icon: KeyboardIcon },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="How to reach it" className="grid grid-cols-3 gap-2">
        {vias.map((v) => {
          const on = v.id === via;
          return (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onVia(v.id)}
              className={`flex flex-col gap-2 rounded-xl p-3 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 ${
                on
                  ? "bg-card shadow-[inset_0_0_0_1.5px_var(--color-text)]"
                  : "bg-card shadow-[0_0_0_1px_var(--color-hairline)] hover:bg-hover"
              }`}
            >
              <v.icon className={`size-4 ${on ? "text-text" : "text-icon"}`} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{v.label}</span>
                <span className="truncate text-[12px] text-text-muted">{v.line}</span>
              </span>
            </button>
          );
        })}
      </div>

      {via === "manual" ? (
        <div className="flex flex-col gap-3 rounded-xl bg-card p-3.5">
          <Field label="Host" hint="Anything ssh takes: a Host from ~/.ssh/config, a hostname, a tailnet IP.">
            <TextInput
              value={address}
              onChange={(event) => onAddress(event.target.value)}
              placeholder="build.example.com or 100.64.0.12"
              autoFocus
              className="font-mono text-[12.5px]"
            />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex h-6 items-center gap-1.5 px-1 text-[12px] text-text-muted">
            {via === "tailnet" ? (
              tailnet?.state === "running" ? (
                <>
                  <ShieldCheckIcon className="size-3.5 text-success" />
                  Tailscale{tailnet.account ? ` · ${tailnet.account}` : ""}
                </>
              ) : (
                <>On your tailnet</>
              )
            ) : (
              <>From ~/.ssh/config</>
            )}
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Look again"
              title="Look again"
              onClick={onLook}
              className="grid size-6 place-items-center rounded-md text-icon hover:bg-hover hover:text-text"
            >
              <RefreshCwIcon className={`size-3.5 ${via === "tailnet" && tailnet === null ? "animate-spin motion-reduce:animate-none" : ""}`} />
            </button>
          </div>
          {via === "tailnet" && tailnet === null && <p className="rounded-xl bg-card px-3.5 py-3 text-text-muted">Asking Tailscale…</p>}
          {via === "tailnet" && tailnet && tailnet.state !== "running" && (
            <p className="flex items-center gap-2 rounded-xl bg-card px-3.5 py-3 text-[12px] text-text-muted">
              <CircleAlertIcon className="size-3.5 shrink-0 text-warning" />
              {tailnet.message ?? "Tailscale is not running"}.
            </p>
          )}
          {via === "ssh" && choices.length === 0 && (
            <p className="rounded-xl bg-card px-3.5 py-3 text-text-muted">No Hosts in ~/.ssh/config. Use an address instead.</p>
          )}
          {choices.length > 0 && (
            <div role="radiogroup" aria-label="Machine" className="flex flex-col rounded-xl bg-card p-1">
              {choices.map((c) => (
                <ChoiceRow key={c.key} choice={c} on={c.key === chosenKey} onPick={() => onPick(c.key)} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={showAdvanced}
          onClick={() => onShowAdvanced(!showAdvanced)}
          className="flex w-fit items-center gap-1 rounded-md px-1 text-[12px] font-medium text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          <ChevronDownIcon className={`size-3.5 transition-transform ${showAdvanced ? "" : "-rotate-90"}`} />
          Advanced options
        </button>
        {showAdvanced && (
          <div className="grid grid-cols-3 gap-3 rounded-xl bg-card p-3.5">
            <Field label="SSH user" hint={chosen?.user ? "Blank uses the one ~/.ssh/config sets." : "Blank uses ~/.ssh/config, or your Mac login."}>
              <TextInput
                value={advanced.user}
                onChange={(event) => onAdvanced({ ...advanced, user: event.target.value })}
                placeholder={chosen?.user || "ubuntu"}
              />
            </Field>
            <Field label="SSH port" error={sshPortOk ? null : "1 to 65535"} hint="Blank uses ~/.ssh/config, or 22.">
              <TextInput
                value={advanced.sshPort}
                inputMode="numeric"
                onChange={(event) => onAdvanced({ ...advanced, sshPort: event.target.value })}
                placeholder={String(chosen?.sshPort ?? 22)}
                className="tabular-nums"
              />
            </Field>
            <Field
              label="Port"
              error={portOk ? null : "1 to 65534"}
              hint={`crewd listens here. Proxy on ${portOk ? Number(advanced.port) + 1 : "the next"}.`}
            >
              <TextInput
                value={advanced.port}
                inputMode="numeric"
                onChange={(event) => onAdvanced({ ...advanced, port: event.target.value })}
                className="tabular-nums"
              />
            </Field>
          </div>
        )}
        <p className="px-1 text-[12px] text-text-muted">
          Nothing is installed outside ~/.crew and ~/.config/systemd/user on that machine.
        </p>
      </div>
    </div>
  );
}

function ChoiceRow({ choice, on, onPick }: { choice: Choice; on: boolean; onPick: () => void }) {
  const off = choice.blocked !== null;
  const Icon = choice.icon;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={off}
      onClick={onPick}
      className={`flex h-10 shrink-0 items-center gap-3 rounded-lg px-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-default ${
        on ? "bg-selected" : off ? "" : "hover:bg-hover"
      }`}
    >
      <span
        className={`grid size-4 shrink-0 place-items-center rounded-full transition-colors ${on ? "bg-accent" : "ring-1 ring-border-strong"} ${off ? "opacity-40" : ""}`}
      >
        {on && <span className="size-1.5 rounded-full bg-inverse" />}
      </span>
      <Icon className={`size-4 shrink-0 ${off ? "text-placeholder" : "text-icon"}`} />
      <span className={`shrink-0 font-mono text-[12.5px] ${off ? "text-placeholder" : ""}`}>{choice.title}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted">{choice.detail}</span>
      {choice.alias && (
        <span className="shrink-0 rounded bg-canvas px-1.5 font-mono text-[10.5px] text-text-muted ring-1 ring-hairline">ssh {choice.alias}</span>
      )}
      {choice.relay && !off && <span className="shrink-0 text-[11px] text-warning">Relay</span>}
      <span className={`shrink-0 text-[11px] ${off ? "text-placeholder" : "text-text-muted"}`}>{choice.blocked ?? choice.note ?? "SSH"}</span>
    </button>
  );
}

/* ── 2. Set up ──────────────────────────────────────────────────────── */

type ViewState = "todo" | "running" | "done" | "error" | "skipped";

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function SetupStepView({ where, steps, failure }: { where: string; steps: Steps; failure: InstallFailure | null }) {
  // Past a failure, the steps that never ran fold into one line, so the fix sits in view.
  const all = INSTALL_STEPS.map((item) => ({ ...item, step: steps[item.id] ?? null }));
  const shown = failure ? all.filter((item) => item.step !== null) : all;
  const unrun = all.length - shown.length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-text-muted">
        Setting up <span className="font-mono text-[12px] text-text">{where}</span>. Nothing is installed outside ~/.crew and
        ~/.config/systemd/user on that machine.
      </p>
      <ol className="flex flex-col rounded-xl bg-card px-3.5 py-3">
        {shown.map((item, index) => {
          const state: ViewState = item.step?.state ?? "todo";
          const upload = item.id === "upload" && state === "running" && item.step?.total ? item.step : null;
          return (
            <StepRow
              key={item.id}
              label={item.label}
              state={state}
              detail={
                upload?.received !== undefined && upload.total
                  ? `Uploading ${megabytes(upload.received)} of ${megabytes(upload.total)} MB`
                  : (item.step?.detail ?? null)
              }
              progress={upload?.received !== undefined && upload.total ? upload.received / upload.total : null}
              last={index === shown.length - 1}
            >
              {state === "error" && failure && <FailureCard failure={failure} />}
            </StepRow>
          );
        })}
      </ol>
      {unrun > 0 && (
        <p className="-mt-2 px-1 text-[12px] text-text-muted">
          {unrun} step{unrun === 1 ? "" : "s"} skipped
        </p>
      )}
    </div>
  );
}

function StepRow({
  label,
  state,
  detail,
  progress,
  last,
  children,
}: {
  label: string;
  state: ViewState;
  detail: string | null;
  progress: number | null;
  last: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-3 last:pb-0">
      {!last && <span className={`absolute top-5 bottom-0 left-[9px] w-px ${state === "done" ? "bg-accent/40" : "bg-hairline"}`} />}
      <span
        className={`relative z-[1] grid size-[19px] shrink-0 place-items-center rounded-full ${
          state === "done"
            ? "bg-accent text-inverse"
            : state === "error"
              ? "bg-danger text-white"
              : state === "running"
                ? "bg-canvas ring-1 ring-accent/50"
                : "bg-canvas ring-1 ring-hairline"
        }`}
      >
        {state === "done" && <CheckIcon className="size-3" strokeWidth={3} />}
        {state === "error" && <XIcon className="size-3" strokeWidth={3} />}
        {state === "running" && <LoaderCircleIcon className="size-3 animate-spin text-accent motion-reduce:animate-none" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 pt-px">
        <span className={state === "todo" || state === "skipped" ? "text-text-muted" : ""}>{label}</span>
        {detail && (
          <span className={`font-mono text-[11px] break-words ${state === "error" ? "text-danger" : "text-text-muted"}`}>{detail}</span>
        )}
        {state === "running" && progress !== null && <ProgressBar value={progress} className="mt-1 max-w-80" />}
        {children && <div className="mt-1.5">{children}</div>}
      </span>
    </li>
  );
}

const HEADLINES: Record<InstallFailure["code"], string> = {
  unreachable: "Can't reach the machine",
  auth: "SSH key refused",
  port: "Port in use",
  other: "Setup failed",
};

function FailureCard({ failure }: { failure: InstallFailure }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-danger/6 p-3.5 ring-1 ring-danger/15">
      <div className="flex items-start gap-2.5">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{HEADLINES[failure.code]}</p>
          {failure.hint && <p className="mt-0.5 text-[12px] text-text-muted">{failure.hint}</p>}
        </div>
      </div>
      {failure.fix && (
        <div className="flex items-center gap-2 rounded-[6px] bg-canvas py-1 pr-1 pl-3">
          <TerminalIcon className="size-3.5 shrink-0 text-icon" />
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]" data-selectable>
            {failure.fix}
          </code>
          <CopyButton text={failure.fix} label="Copy command" />
        </div>
      )}
    </div>
  );
}

/* ── 3. Name ────────────────────────────────────────────────────────── */

function NameStep({
  name,
  onName,
  env,
  steps,
  found,
  error,
  onSubmit,
}: {
  name: string;
  onName: (name: string) => void;
  env: RemoteEnv;
  steps: Steps;
  found: string[];
  error: string | null;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Name" hint="You can change this later." error={error}>
        <TextInput
          value={name}
          onChange={(event) => onName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) onSubmit();
          }}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
        />
      </Field>
      <div className="flex flex-col gap-1">
        <p className="px-1 text-[12px] font-medium text-text-muted">Detected</p>
        <dl className="rounded-xl bg-card px-3.5 [&>*+*]:border-t [&>*+*]:border-hairline">
          <Line label="Machine">
            <span className="font-mono text-[12px]">{env.ssh || env.host}</span>
            <span className="text-text-muted">
              · {env.host}:{env.port}
            </span>
          </Line>
          <Line label="crewd">{steps.pair?.detail ?? "Paired"}</Line>
          <Line label="Agents">
            <FoundAgents found={found} />
          </Line>
        </dl>
      </div>
    </div>
  );
}

function FoundAgents({ found }: { found: string[] }) {
  const missing = PROVIDERS.filter((p) => !found.includes(p.binary));
  return (
    <span className="flex min-w-0 flex-col gap-1 py-1">
      <span className="flex items-center gap-1">
        {PROVIDERS.map((p) => (
          <span key={p.id} className={`grid size-6 place-items-center rounded-md ${found.includes(p.binary) ? "bg-canvas" : ""}`}>
            <ProviderIcon provider={p.id} className={`size-3.5 ${found.includes(p.binary) ? "" : "opacity-40 grayscale"}`} />
          </span>
        ))}
      </span>
      {missing.length > 0 && <span className="text-[12px] text-text-muted">Missing: {missing.map((p) => p.label).join(", ")}</span>}
    </span>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-11 grid-cols-[72px_minmax(0,1fr)] items-center gap-3 py-1">
      <dt className="text-[12px] text-text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5">{children}</dd>
    </div>
  );
}

/* ── Done ───────────────────────────────────────────────────────────── */

// `warning`: what the service step said, which it only does when lingering is off.
function DoneStep({ name, found, warning }: { name: string; found: string[]; warning: string | null }) {
  const absent = PROVIDERS.filter((p) => !found.includes(p.binary)).length;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <span className="grid size-14 place-items-center rounded-[18px] bg-success/12 text-success">
        <CheckIcon className="size-7" strokeWidth={2.5} />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[16px] font-semibold tracking-[-0.01em]">{name} is ready</p>
        <p className="max-w-sm text-text-muted">
          {absent === PROVIDERS.length
            ? "No agent CLI found. Install and sign in to one."
            : absent > 0
              ? `${absent} agent${absent === 1 ? "" : "s"} not installed.`
              : "Open a workspace to start."}
        </p>
      </div>
      <span className="flex items-center gap-1">
        {PROVIDERS.map((p) => (
          <span key={p.id} className={`grid size-7 place-items-center rounded-lg ${found.includes(p.binary) ? "bg-card" : ""}`}>
            <ProviderIcon provider={p.id} className={`size-4 ${found.includes(p.binary) ? "" : "opacity-40 grayscale"}`} />
          </span>
        ))}
      </span>
      {warning && (
        <p className="flex max-w-md items-start gap-1.5 text-left text-[12px] text-text-muted">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0 text-warning" /> {warning}
        </p>
      )}
    </div>
  );
}
