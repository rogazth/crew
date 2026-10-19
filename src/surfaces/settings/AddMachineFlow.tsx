// Adding a machine, as a guided dialog in three steps:
// how to reach it (a Host from ~/.ssh/config, a tailnet device, or an address
// typed in), the setup walking live (resolve, ssh, look for crewd, install it,
// start it, pair, look for agent CLIs) with a clear way past each failure,
// then its name. The dialog keeps one size through every step. Simulated
// (pending.ts runSetup) and not reachable in the app until S4 of
// docs/plans/2026-10-19-design-system-finish.md; the real one is surfaces/AddMachine.tsx.
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Field, IconButton, Overlay, TextInput } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { PROVIDERS } from "../../lib/providers";
import {
  SSH_CONFIG,
  TAILNET,
  addEnv,
  runSetup,
  useEnvs,
  type EnvKind,
  type SetupFailure,
  type SetupResult,
  type SetupStep,
  type SetupTarget,
} from "./pending";
import { manageProviders } from "./route";
import { seedEnvProviders } from "./pending";
import { CopyButton, ProgressBar, toast } from "./ui";

type Via = "ssh" | "tailnet" | "manual";
type Stage = "connect" | "setup" | "name" | "done";

const STAGES: { id: Exclude<Stage, "done">; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "setup", label: "Set up" },
  { id: "name", label: "Name" },
];

/** A machine the first step can offer, and why not when it can't. */
type Choice = { key: string; via: Via; title: string; detail: string; note: string | null; blocked: string | null; target: SetupTarget; icon: LucideIcon; relay?: boolean };

export function AddMachineFlow({ onClose }: { onClose: () => void }) {
  const envs = useEnvs();
  const [via, setVia] = useState<Via>("ssh");
  const [picked, setPicked] = useState<Record<Via, string | null>>({ ssh: null, tailnet: null, manual: null });
  const [manual, setManual] = useState({ host: "", user: "", port: "22" });
  const [stage, setStage] = useState<Stage>("connect");
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [failure, setFailure] = useState<SetupFailure | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [name, setName] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);

  const taken = new Set(envs.flatMap((env) => [env.ssh, env.address, env.name, env.hostname].filter(Boolean) as string[]));

  const sshChoices: Choice[] = SSH_CONFIG.map((h) => ({
    key: `ssh:${h.alias}`,
    via: "ssh",
    title: h.alias,
    detail: `${h.user}@${h.hostname}${h.port !== 22 ? `:${h.port}` : ""}`,
    note: null,
    blocked: taken.has(h.alias) ? "Added" : null,
    target: { ssh: h.alias, user: h.user, port: h.port, host: h.hostname },
    icon: TerminalIcon,
  }));
  const tailnetChoices: Choice[] = TAILNET.devices.map((d) => ({
    key: `tailnet:${d.ip}`,
    via: "tailnet",
    title: d.host,
    detail: d.ip,
    note: d.os,
    blocked: taken.has(d.host) || taken.has(d.ip) ? "Added" : !d.online ? "Offline" : d.os === "iOS" ? "Unsupported" : null,
    target: { ssh: d.host, user: "", port: 22, host: d.ip },
    icon: d.os === "iOS" ? SmartphoneIcon : d.os === "macOS" ? LaptopIcon : ServerIcon,
    relay: d.relay,
  }));
  const list = via === "ssh" ? sshChoices : tailnetChoices;
  const firstFree = list.find((c) => !c.blocked)?.key ?? null;
  const chosenKey = via === "manual" ? null : (picked[via] ?? firstFree);
  const chosen: Choice | null =
    via === "manual"
      ? manual.host.trim()
        ? {
            key: "manual",
            via: "manual",
            title: manual.host.trim(),
            detail: "",
            note: null,
            blocked: null,
            target: { ssh: manual.host.trim(), user: manual.user.trim(), port: Number(manual.port) || 22, host: manual.host.trim() },
            icon: KeyboardIcon,
          }
        : null
      : (list.find((c) => c.key === chosenKey) ?? null);
  const portOk = via !== "manual" || (/^\d+$/.test(manual.port) && Number(manual.port) > 0 && Number(manual.port) < 65536);

  const start = () => {
    if (!chosen) return;
    cancel.current?.();
    setStage("setup");
    setFailure(null);
    setResult(null);
    const job = runSetup(chosen.target, setSteps);
    cancel.current = job.cancel;
    job.done.then(
      (found) => {
        setResult(found);
        setName((current) => current || suggestName(chosen.title));
      },
      (reason: SetupFailure) => setFailure(reason),
    );
  };

  const back = () => {
    cancel.current?.();
    cancel.current = null;
    setStage("connect");
    setSteps([]);
    setFailure(null);
  };

  const finish = () => {
    if (!chosen || !result || !name.trim()) return;
    const kind: EnvKind = chosen.via === "tailnet" ? "tailscale" : "ssh";
    const env = addEnv({ name: name.trim(), ssh: chosen.target.ssh, host: chosen.target.host, kind, result });
    seedEnvProviders(env.id, result.clis);
    setAdded(env.id);
    setStage("done");
  };

  const at = stage === "done" ? STAGES.length : STAGES.findIndex((s) => s.id === stage);

  return (
    <Overlay onClose={onClose} width="w-[620px]" label="Add a machine">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline pr-2.5 pl-5">
        <h2 className="text-[14px] font-semibold">Add a machine</h2>
        <span className="flex-1" />
        <Stepper at={at} />
        <IconButton icon={XIcon} label="Close" className="ml-2 size-7" onClick={onClose} />
      </div>

      <div className="h-[480px] overflow-y-auto px-5 py-4">
        {stage === "connect" && (
          <ConnectStep
            via={via}
            onVia={setVia}
            choices={list}
            chosenKey={chosenKey}
            onPick={(key) => setPicked((current) => ({ ...current, [via]: key }))}
            manual={manual}
            onManual={setManual}
            portOk={portOk}
          />
        )}
        {stage === "setup" && chosen && <SetupStepView target={chosen.target} steps={steps} failure={failure} />}
        {stage === "name" && chosen && result && <NameStep name={name} onName={setName} choice={chosen} result={result} />}
        {stage === "done" && <DoneStep name={name.trim()} result={result} />}
      </div>

      <div className="flex h-14 shrink-0 items-center gap-2 border-t border-hairline px-4">
        {stage === "connect" && (
          <>
            <p className="min-w-0 flex-1 truncate text-[12px] text-text-muted">Uses your SSH keys. Installs to ~/.crew.</p>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!chosen || !portOk} onClick={start}>
              Connect
              <ArrowRightIcon className="size-4" />
            </Button>
          </>
        )}
        {stage === "setup" && (
          <>
            <Button variant="ghost" icon={ArrowLeftIcon} onClick={back}>
              Back
            </Button>
            <span className="flex-1" />
            {failure?.step === "resolve" ? (
              <>
                <Button variant="ghost" icon={RefreshCwIcon} onClick={start}>
                  Retry
                </Button>
                <Button variant="primary" onClick={back}>
                  Edit address
                </Button>
              </>
            ) : failure ? (
              <Button variant="primary" icon={RefreshCwIcon} onClick={start}>
                Retry
              </Button>
            ) : (
              <Button variant="primary" disabled={!result} onClick={() => setStage("name")}>
                {result ? "Continue" : "Setting up…"}
                {result && <ArrowRightIcon className="size-4" />}
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
            <Button variant="primary" disabled={!name.trim()} onClick={finish}>
              Add machine
            </Button>
          </>
        )}
        {stage === "done" && (
          <>
            <span className="flex-1" />
            <Button
              variant="ghost"
              onClick={() => {
                toast(`Choose a folder on ${name.trim()}`, "info");
                onClose();
              }}
            >
              Open workspace…
            </Button>
            {result && result.clis.length < PROVIDERS.length && added && (
              <Button
                onClick={() => {
                  onClose();
                  manageProviders(added);
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

function suggestName(title: string): string {
  return title.split(".")[0]!.replace(/^\d+$/, "machine");
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

const VIAS: { id: Via; label: string; line: string; icon: LucideIcon }[] = [
  { id: "ssh", label: "SSH config", line: `${SSH_CONFIG.length} hosts`, icon: FileCode2Icon },
  { id: "tailnet", label: "Tailscale", line: `${TAILNET.devices.length} devices`, icon: NetworkIcon },
  { id: "manual", label: "Address", line: "Enter manually", icon: KeyboardIcon },
];

function ConnectStep({
  via,
  onVia,
  choices,
  chosenKey,
  onPick,
  manual,
  onManual,
  portOk,
}: {
  via: Via;
  onVia: (via: Via) => void;
  choices: Choice[];
  chosenKey: string | null;
  onPick: (key: string) => void;
  manual: { host: string; user: string; port: string };
  onManual: (next: { host: string; user: string; port: string }) => void;
  portOk: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="How to reach it" className="grid grid-cols-3 gap-2">
        {VIAS.map((v) => {
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
          <Field label="Host" hint="Hostname, IP or tailnet address.">
            <TextInput
              value={manual.host}
              onChange={(event) => onManual({ ...manual, host: event.target.value })}
              placeholder="build.example.com or 100.64.0.12"
              autoFocus
              className="font-mono text-[12.5px]"
            />
          </Field>
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field label="User" hint="Defaults to your login.">
              <TextInput value={manual.user} onChange={(event) => onManual({ ...manual, user: event.target.value })} placeholder="ubuntu" />
            </Field>
            <Field label="SSH port" error={portOk ? null : "1 to 65535"}>
              <TextInput
                value={manual.port}
                inputMode="numeric"
                onChange={(event) => onManual({ ...manual, port: event.target.value })}
                className="tabular-nums"
              />
            </Field>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 px-1 text-[12px] text-text-muted">
            {via === "tailnet" ? (
              <>
                <ShieldCheckIcon className="size-3.5 text-success" />
                Tailscale · {TAILNET.account}
              </>
            ) : (
              <>From ~/.ssh/config</>
            )}
          </div>
          <div role="radiogroup" aria-label="Machine" className="flex flex-col rounded-xl bg-card p-1">
            {choices.map((c) => (
              <ChoiceRow key={c.key} choice={c} on={c.key === chosenKey} onPick={() => onPick(c.key)} />
            ))}
          </div>
        </div>
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
      className={`flex h-10 items-center gap-3 rounded-lg px-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-default ${
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
      {choice.relay && !off && <span className="shrink-0 text-[11px] text-warning">Relay</span>}
      <span className={`shrink-0 text-[11px] ${off ? "text-placeholder" : "text-text-muted"}`}>{choice.blocked ?? choice.note ?? "SSH"}</span>
    </button>
  );
}

/* ── 2. Set up ──────────────────────────────────────────────────────── */

function SetupStepView({ target, steps, failure }: { target: SetupTarget; steps: SetupStep[]; failure: SetupFailure | null }) {
  // Past a failure, the steps that never ran fold into one line, so the fix sits in view.
  const shown = steps.filter((step) => step.state !== "skipped");
  const skipped = steps.length - shown.length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-text-muted">
        Setting up{" "}
        <span className="font-mono text-[12px] text-text">
          {target.user ? `${target.user}@` : ""}
          {target.ssh}
        </span>
      </p>
      <ol className="flex flex-col rounded-xl bg-card px-3.5 py-3">
        {shown.map((step, index) => (
          <StepRow key={step.id} step={step} last={index === shown.length - 1}>
            {step.state === "error" && failure && <FailureCard failure={failure} />}
          </StepRow>
        ))}
      </ol>
      {skipped > 0 && (
        <p className="-mt-2 px-1 text-[12px] text-text-muted">
          {skipped} step{skipped === 1 ? "" : "s"} skipped
        </p>
      )}
    </div>
  );
}

function StepRow({ step, last, children }: { step: SetupStep; last: boolean; children?: ReactNode }) {
  const { state } = step;
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
        <span className={state === "todo" || state === "skipped" ? "text-text-muted" : ""}>{step.label}</span>
        {step.detail && (
          <span className={`font-mono text-[11px] break-words ${state === "error" ? "text-danger" : "text-text-muted"}`}>{step.detail}</span>
        )}
        {state === "running" && step.progress !== null && <ProgressBar value={step.progress} className="mt-1 max-w-80" />}
        {children && <div className="mt-1.5">{children}</div>}
      </span>
    </li>
  );
}

function FailureCard({ failure }: { failure: SetupFailure }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-danger/6 p-3.5 ring-1 ring-danger/15">
      <div className="flex items-start gap-2.5">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{headline(failure)}</p>
          <p className="mt-0.5 text-[12px] text-text-muted">{failure.hint}</p>
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

function headline(failure: SetupFailure): string {
  if (failure.step === "resolve") return "Can't resolve host";
  if (failure.step === "connect") return "SSH key refused";
  return "Setup failed";
}

/* ── 3. Name ────────────────────────────────────────────────────────── */

function NameStep({ name, onName, choice, result }: { name: string; onName: (name: string) => void; choice: Choice; result: SetupResult }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Name" hint="You can change this later.">
        <TextInput value={name} onChange={(event) => onName(event.target.value)} autoFocus onFocus={(event) => event.currentTarget.select()} />
      </Field>
      <div className="flex flex-col gap-1">
        <p className="px-1 text-[12px] font-medium text-text-muted">Detected</p>
        <dl className="rounded-xl bg-card px-3.5 [&>*+*]:border-t [&>*+*]:border-hairline">
          <Line label="Machine">
            <span className="font-mono text-[12px]">{choice.target.host}</span>
            <span className="text-text-muted">
              · {result.os} · {result.arch}
            </span>
          </Line>
          <Line label="crewd">
            0.3.13 <span className="text-text-muted">· port 7777 · direct</span>
          </Line>
          <Line label="Agents">
            <FoundAgents found={result.clis} />
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
      {missing.length > 0 && (
        <span className="text-[12px] text-text-muted">
          Missing: {missing.map((p) => p.label).join(", ")}
        </span>
      )}
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

function DoneStep({ name, result }: { name: string; result: SetupResult | null }) {
  const missing = result ? PROVIDERS.length - result.clis.length : 0;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <span className="grid size-14 place-items-center rounded-[18px] bg-success/12 text-success">
        <CheckIcon className="size-7" strokeWidth={2.5} />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[16px] font-semibold tracking-[-0.01em]">{name} is ready</p>
        <p className="max-w-sm text-text-muted">
          {missing > 0 ? `${missing} agent${missing === 1 ? "" : "s"} not installed.` : "Open a workspace to start."}
        </p>
      </div>
      {result && (
        <span className="flex items-center gap-1">
          {PROVIDERS.map((p) => (
            <span key={p.id} className={`grid size-7 place-items-center rounded-lg ${result.clis.includes(p.binary) ? "bg-card" : ""}`}>
              <ProviderIcon provider={p.id} className={`size-4 ${result.clis.includes(p.binary) ? "" : "opacity-40 grayscale"}`} />
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
