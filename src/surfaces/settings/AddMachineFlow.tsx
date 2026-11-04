// Adding a machine, as a guided dialog in three steps:
// a device on the tailnet (reached through its Host in ~/.ssh/config when it has
// one), the setup walking live through the backend's own steps (reach,
// sign in, look for a crewd, upload, service, pair, agent CLIs) with a clear
// way past each failure, then its name. Everything here is real: ~/.ssh/config and Tailscale are read on
// open, and the install is `remotesHost().install` with its progress events.
import {
  CheckIcon,
  CircleAlertIcon,
  LaptopIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ServerIcon,
  SmartphoneIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Field, Overlay, TextInput } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { bareHost } from "../../lib/envText";
import { useEnvLinks } from "../../hooks/useEnvLinks";
import * as api from "../../lib/api";
import { refreshRemotes } from "../../lib/client/registry";
import { openUrl, remotesHost } from "../../lib/host";
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
import { DialogFooter, DialogHeader } from "./integrations/dialog";
import { manageProviders } from "./route";
import { ProgressBar } from "./ui";

type Stage = "connect" | "setup" | "name" | "done";


/** A machine the first step can offer, and why not when it can't. */
type Choice = {
  key: string;
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

type Advanced = { user: string; port: string };

const FRESH: Advanced = { user: "", port: String(DEFAULT_PORT) };

type Steps = Partial<Record<InstallStepId, InstallStep>>;

function glyphOf(os: string): LucideIcon {
  if (os === "iOS" || os === "Android") return SmartphoneIcon;
  if (os === "macOS" || os === "Windows") return LaptopIcon;
  return ServerIcon;
}

export function AddMachineFlow({
  onClose,
  known,
}: {
  onClose: () => void;
  /** Tailscale as the page already read it, so the list is there from the first paint. */
  known: Tailnet | null;
}) {
  const host = remotesHost();
  const links = useEnvLinks();
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [tailnet, setTailnet] = useState<Tailnet | null>(known);
  const [looking, setLooking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState<Advanced>(FRESH);
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
    setLooking(true);
    void host
      .tailnet()
      .then(setTailnet, (reason: unknown) => setTailnet({ state: "error", account: null, message: errorText(reason), devices: [] }))
      .finally(() => setLooking(false));
    void host.sshHosts().then(setSshHosts, () => {});
  }, [host]);
  useEffect(load, [load]);

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
  const added = new Set(
    links.flatMap((link) =>
      [link.ssh, link.host].filter((value): value is string => !!value).flatMap((value) => [value, bareHost(value)]),
    ),
  );
  const isAdded = (...values: string[]) => values.some((value) => added.has(value));

  const list: Choice[] = devices.filter((device) => !device.self).map((device) => {
    const alias = aliasOf(device);
    return {
      key: `tailnet:${device.ip}`,
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
  const firstFree = list.find((choice) => !choice.blocked)?.key ?? null;
  const chosenKey = picked ?? firstFree;
  const chosen = list.find((choice) => choice.key === chosenKey) ?? null;

  const portNumber = Number(advanced.port);
  const portOk = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65535;
  const ready = chosen !== null && portOk;

  const choose = (key: string | null) => {
    setPicked(key);
    // Overrides belong to the machine they were typed for.
    setAdvanced((current) => ({ ...current, user: "" }));
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
        tailnetIp: chosen.detail,
        user: advanced.user.trim(),
        port: portNumber,
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

  const found = foundClis(steps);
  const missing = PROVIDERS.filter((provider) => !found.includes(provider.binary));
  const absent = PROVIDERS.length - found.length;
  const head =
    stage === "connect"
      ? { title: "Add a machine", subtitle: "Pick a device on your Tailscale network." }
      : stage === "setup"
        ? failure
          ? { title: `Couldn't set up ${chosen?.label ?? "the machine"}`, subtitle: undefined }
          : { title: `Setting up ${chosen?.label ?? "the machine"}`, subtitle: "This takes a minute." }
        : stage === "name"
          ? { title: "Name this machine", subtitle: "You can change this later." }
          : {
              title: `${created?.name ?? "It"} is ready`,
              subtitle:
                absent === PROVIDERS.length
                  ? "No agent found. Install and sign in to one."
                  : absent > 0
                    ? `${absent} agent${absent === 1 ? "" : "s"} not installed.`
                    : "Open a workspace to start.",
            };

  return (
    <Overlay onClose={close} width="w-[460px]" label="Add a machine">
      <DialogHeader
        onClose={close}
        mark={
          <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-card">
            {stage === "done" ? <CheckIcon className="size-5 text-success" /> : <ServerIcon className="size-5 text-icon" />}
          </span>
        }
        title={head.title}
        subtitle={head.subtitle}
      />
      {/* One size through every step: nothing around it jumps as the install moves on. */}
      <div className="h-[400px] overflow-y-auto">
        {!host && <p className="px-5 pb-5 text-text-muted">Adding a machine needs the Crew app.</p>}
        {host && stage === "connect" && (
          <ConnectStep
            choices={list}
            chosenKey={chosenKey}
            onPick={choose}
            tailnet={tailnet}
            onLook={load}
            looking={looking}
          />
        )}
        {stage === "setup" && <SetupStepView steps={steps} failure={failure} advanced={advanced} onAdvanced={setAdvanced} portOk={portOk} />}
        {stage === "name" && created && (
          <NameStep name={name} onName={setName} env={created} steps={steps} found={found} error={saveError} onSubmit={() => void finish()} />
        )}
        {stage === "done" && created && <DoneStep found={found} warning={steps.service?.detail ?? null} />}
      </div>
      {stage === "connect" && (
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!host || !ready} onClick={start}>
            Connect
          </Button>
        </DialogFooter>
      )}
      {stage === "setup" && (
        <DialogFooter
          start={
            <Button variant="ghost" disabled={cancelling} onClick={() => void back()}>
              {created || failure ? "Back" : cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          }
        >
          {failure ? (
            <Button variant="primary" disabled={!ready} onClick={start}>
              Try again
            </Button>
          ) : (
            <Button variant="primary" disabled={!created} onClick={() => setStage("name")}>
              {created ? "Continue" : "Setting up…"}
            </Button>
          )}
        </DialogFooter>
      )}
      {stage === "name" && (
        <DialogFooter
          start={
            <Button variant="ghost" onClick={() => setStage("setup")}>
              Back
            </Button>
          }
        >
          <Button variant="primary" disabled={!name.trim() || saving} onClick={() => void finish()}>
            {saving ? "Saving…" : "Add machine"}
          </Button>
        </DialogFooter>
      )}
      {stage === "done" && created && (
        <DialogFooter>
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
        </DialogFooter>
      )}
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

/* ── 1. Connect ─────────────────────────────────────────────────────── */

function ConnectStep({
  choices,
  chosenKey,
  onPick,
  tailnet,
  onLook,
  looking,
}: {
  choices: Choice[];
  chosenKey: string | null;
  onPick: (key: string) => void;
  tailnet: Tailnet | null;
  onLook: () => void;
  looking: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 pb-5">
      <div className="flex flex-col gap-2">
        <div className="flex h-6 items-center gap-1.5 px-1 text-[13px] text-text-muted">
          <span className="min-w-0 flex-1 truncate">{tailnet?.account ?? "Tailscale"}</span>
          <button
            type="button"
            aria-label="Look again"
            title="Look again"
            onClick={onLook}
            className="grid size-6 place-items-center rounded-md text-icon hover:bg-hover hover:text-text"
          >
            <RefreshCwIcon className={`size-3.5 ${looking ? "animate-spin motion-reduce:animate-none" : ""}`} />
          </button>
        </div>
        {tailnet === null && <p className="rounded-xl bg-card px-3.5 py-3 text-text-muted">Asking Tailscale…</p>}
        {tailnet?.state === "missing" && (
          <TailscaleNeeded
            title="Install Tailscale"
            line="Needed to connect your other machines."
            action="Get Tailscale"
            url={TAILSCALE_DOWNLOAD}
          />
        )}
        {tailnet && tailnet.state !== "running" && tailnet.state !== "missing" && (
          <TailscaleNeeded title="Tailscale isn't running" line={tailnet.message ?? "Open Tailscale and sign in, then look again."} />
        )}
        {tailnet?.state === "running" && choices.length === 0 && (
          <TailscaleNeeded
            title="No other devices yet"
            line="Install Tailscale on the machine you want to add and sign in with the same account."
            action="Add a device"
            url={TAILSCALE_ADD_DEVICE}
          />
        )}
        {choices.length > 0 && (
          <div role="radiogroup" aria-label="Machine" className="flex flex-col rounded-xl bg-card px-3">
            {choices.map((c) => (
              <ChoiceRow key={c.key} choice={c} on={c.key === chosenKey} onPick={() => onPick(c.key)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
const TAILSCALE_ADD_DEVICE = "https://login.tailscale.com/admin/machines/new-linux";

/** What stands between this Mac and a machine to add, and the way past it. */
function TailscaleNeeded({ title, line, action, url }: { title: string; line: string; action?: string; url?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl bg-card px-4 py-8 text-center">
      <p className="text-[14px] font-medium">{title}</p>
      <p className="max-w-[380px] text-text-muted">{line}</p>
      {action && url && (
        <Button variant="primary" className="mt-2.5" onClick={() => void openUrl(url)}>
          {action}
        </Button>
      )}
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
      className={`flex min-h-14 items-center gap-3 border-t border-hairline py-2 text-left outline-none first:border-t-0 focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-default ${off ? "opacity-50" : ""}`}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--color-hairline)]">
        <Icon className="size-4 text-icon" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{choice.title}</span>
        <span className="truncate text-[12px] text-text-muted">{choice.blocked ?? choice.note}</span>
      </span>
      <span className={`grid size-4 shrink-0 place-items-center rounded-full transition-colors ${on ? "bg-accent" : "ring-1 ring-border-strong"}`}>
        {on && <span className="size-1.5 rounded-full bg-inverse" />}
      </span>
    </button>
  );
}

/* ── 2. Set up ──────────────────────────────────────────────────────── */

type ViewState = "todo" | "running" | "done" | "error" | "skipped";

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function SetupStepView({
  steps,
  failure,
  advanced,
  onAdvanced,
  portOk,
}: {
  steps: Steps;
  failure: InstallFailure | null;
  advanced: Advanced;
  onAdvanced: (next: Advanced) => void;
  portOk: boolean;
}) {
  // Past a failure, the steps that never ran go, so the fix sits in view.
  const all = INSTALL_STEPS.map((item) => ({ ...item, step: steps[item.id] ?? null }));
  const shown = failure ? all.filter((item) => item.step !== null) : all;
  return (
    <div className="px-4 pb-5">
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
              {state === "error" && failure && (
                <FailureCard failure={failure}>
                  {/* What only the person knows, asked for when it is what stopped the setup. */}
                  {failure.code === "auth" && (
                    <Field label="SSH user">
                      <TextInput
                        value={advanced.user}
                        placeholder="ubuntu"
                        onChange={(event) => onAdvanced({ ...advanced, user: event.target.value })}
                      />
                    </Field>
                  )}
                  {failure.code === "port" && (
                    <Field label="Port" error={portOk ? null : "1 to 65534"}>
                      <TextInput
                        value={advanced.port}
                        inputMode="numeric"
                        className="tabular-nums"
                        onChange={(event) => onAdvanced({ ...advanced, port: event.target.value })}
                      />
                    </Field>
                  )}
                </FailureCard>
              )}
            </StepRow>
          );
        })}
      </ol>
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
    <li className="relative flex gap-3 pb-2 last:pb-0">
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
      <span className="flex min-w-0 flex-1 flex-col pt-px">
        <span className={state === "todo" || state === "skipped" ? "text-text-muted" : ""}>{label}</span>
        {state !== "error" && (
          <span className="min-h-[1lh] truncate text-[12px] text-text-muted" title={detail ?? undefined}>
            {detail}
          </span>
        )}
        {state === "running" && progress !== null && <ProgressBar value={progress} className="mt-1 max-w-80" />}
        {children && <div className="mt-1.5">{children}</div>}
      </span>
    </li>
  );
}

/** What went wrong and what to do, in plain words; the machine's own wording stays in the tooltip. */
const FAILURES: Record<InstallFailure["code"], { title: string; line: string | null }> = {
  unreachable: { title: "Can't reach the machine", line: "Make sure it's on and connected to Tailscale." },
  auth: { title: "Couldn't sign in", line: "Make sure your SSH key is on the machine, or try another user." },
  port: { title: "Port in use", line: "Choose another one." },
  other: { title: "Setup failed", line: null },
};

function FailureCard({ failure, children }: { failure: InstallFailure; children?: ReactNode }) {
  const { title, line } = FAILURES[failure.code];
  return (
    <div className="flex flex-col gap-2.5 rounded-lg bg-canvas p-3 shadow-[0_0_0_1px_var(--color-hairline)]" title={failure.message}>
      <div className="flex items-start gap-2.5">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="mt-0.5 line-clamp-2 text-[12px] text-text-muted">{line ?? failure.message}</p>
        </div>
      </div>
      {children}
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
    <div className="flex flex-col gap-4 px-4 pb-5">
      <Field label="Name" error={error}>
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
        <p className="px-1 text-[13px] text-text-muted">Detected</p>
        <dl className="rounded-xl bg-card px-3.5 [&>*+*]:border-t [&>*+*]:border-hairline">
          <Line label="Machine">
            {env.ssh || env.host}
          </Line>
          <Line label="Version">{steps.pair?.detail ?? "Paired"}</Line>
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
function DoneStep({ found, warning }: { found: string[]; warning: string | null }) {
  return (
    <div className="flex flex-col gap-3 px-4 pb-5">
      <div className="rounded-xl bg-card px-3.5">
        <Line label="Agents">
          <FoundAgents found={found} />
        </Line>
      </div>
      {warning && (
        <p className="flex items-start gap-1.5 px-1 text-[12px] text-text-muted">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0 text-warning" /> {warning}
        </p>
      )}
    </div>
  );
}
