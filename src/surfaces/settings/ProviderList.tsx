// Providers' lower half: the CLIs on one machine. A picker at the top says
// which machine (this Mac or a remote); each machine has its own installs,
// versions and sign-ins, and an install on a remote runs there over SSH.
// Simulated (pending.ts) and not reachable in the app until S3 of
// docs/plans/2026-10-19-design-system-finish.md.
import { Menu } from "@base-ui/react/menu";
import {
  ArrowDownToLineIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  EllipsisIcon,
  FolderSearchIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  TerminalIcon,
  Trash2Icon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { Button, IconButton, PANEL, ROW, Segmented } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { LOCAL_ENV, hereOf, reconnectEnv, setProvidersEnv, stateLabel, updateCrewd, useEnvs, useProvidersEnv, type EnvMock } from "./pending";
import { EnvGlyph, StateDot } from "./pendingParts";
import {
  cancelJob,
  dismissFailure,
  installProvider,
  installWithNode,
  METHOD_LABELS,
  setMethod,
  signIn,
  signOut,
  statusOf,
  uninstall,
  updateProvider,
  useAllProviders,
  type InstallMethod,
  type ProviderMock,
  type Status,
} from "./pending";
import { Callout, Chip, CopyButton, Heading, ProgressBar, toast, type Tone } from "./ui";

const STATUS: Record<Status, { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "Up to date" },
  update: { tone: "info", label: "Update available" },
  "signed-out": { tone: "warning", label: "Signed out" },
  "not-installed": { tone: "neutral", label: "Not installed" },
  failed: { tone: "danger", label: "Install failed" },
  installing: { tone: "accent", label: "Installing" },
  updating: { tone: "accent", label: "Updating" },
};

/** What a card may do on its machine: everything, or only look while it is unreachable. */
type Ctx = { env: EnvMock; live: boolean };

export function ProviderList() {
  const envs = useEnvs();
  const viewing = useProvidersEnv();
  const all = useAllProviders();
  const env = envs.find((e) => e.id === viewing) ?? envs[0]!;
  const providers = all[env.id] ?? [];
  // A card being installed stays where it was until the install lands.
  const ready = providers.filter((p) => p.version);
  const available = providers.filter((p) => !p.version);
  const live = env.state === "connected" && !env.busy;
  const ctx: Ctx = { env, live };
  const local = env.kind === "local";

  return (
    <section className="flex flex-col gap-4">
      <div data-setting="providers-env" className="flex items-center gap-3 px-1">
        <EnvPicker env={env} envs={envs} all={all} />
        <span className="flex-1" />
        <span className="text-[12px] text-text-muted tabular-nums">
          {ready.length} of {providers.length} installed
        </span>
      </div>
      {!live && <Unreachable env={env} />}
      <div className="flex flex-col gap-3">
        <Heading
          title="Installed"
          />
        {ready.length === 0 ? (
          <p className="rounded-xl bg-card px-4 py-5 text-center text-text-muted">
            No agents installed on {hereOf(env)}.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {ready.map((p) => (
              <ProviderCard key={p.id} p={p} ctx={ctx} />
            ))}
          </div>
        )}
      </div>
      {available.length > 0 && (
        <div className="flex flex-col gap-3">
          <Heading
            title={local ? "More agents" : `Not on ${env.name}`}
            {...(local ? {} : { description: `Installs on ${env.name} over SSH.` })}
          />
          <div className="flex flex-col gap-4">
            {available.map((p) => (
              <ProviderCard key={p.id} p={p} ctx={ctx} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* ── Which machine ──────────────────────────────────────────────────── */

/** A fixed-width trigger: picking a machine with a longer name never moves the row. */
function EnvPicker({ env, envs, all }: { env: EnvMock; envs: EnvMock[]; all: Record<string, ProviderMock[]> }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Machine"
        className="flex h-9 w-60 items-center gap-2.5 rounded-lg bg-card pr-2 pl-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-hover"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-canvas text-icon">
          <EnvGlyph env={env} className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{env.name}</span>
        <StateDot env={env} className="size-2" />
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-icon" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={`${PANEL} w-72`}>
            <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-text-muted">Machine</div>
            {envs.map((e) => {
              const list = all[e.id] ?? [];
              const count = list.filter((p) => p.version).length;
              return (
                <Menu.Item key={e.id} className={`${ROW} h-11`} onClick={() => setProvidersEnv(e.id)}>
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-card text-icon">
                    <EnvGlyph env={e} className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{e.name}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                      <StateDot env={e} />
                      {stateLabel(e)} · {count}/{list.length} installed
                    </span>
                  </span>
                  <CheckIcon className={`size-4 shrink-0 ${e.id === env.id ? "" : "invisible"}`} />
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Unreachable({ env }: { env: EnvMock }) {
  const mismatch = env.state === "error";
  const busy = env.busy !== null || env.state === "connecting";
  if (busy) return <Callout tone="neutral" icon={LoaderCircleIcon} spinning title={`${env.busy ?? "Connecting"} on ${env.name}…`} />;
  if (mismatch)
    return (
      <Callout
        tone="accent"
        icon={ArrowDownToLineIcon}
        title="Update available for crewd"
        description={`${env.name} runs ${env.crewd}; update it to keep working there.`}
        action={
          <Button variant="primary" onClick={() => updateCrewd(env.id)}>
            Update
          </Button>
        }
      />
    );
  return (
    <Callout
      tone="neutral"
      icon={WifiOffIcon}
      title={`${env.name} is offline`}
      description={`Last seen ${env.lastSeen}`}
      action={
        <Button icon={RefreshCwIcon} onClick={() => reconnectEnv(env.id)}>
          Retry
        </Button>
      }
    />
  );
}

/* ── One provider ───────────────────────────────────────────────────── */

function ProviderCard({ p, ctx }: { p: ProviderMock; ctx: Ctx }) {
  const status = statusOf(p);
  const chip = STATUS[status];
  const installedNow = Boolean(p.version);
  return (
    // A filled card on the page, its facts straight on it: no shadow, no second ground inside.
    <article data-setting={`provider-${p.id}`} className="flex flex-col gap-3 rounded-[14px] bg-card p-4">
      <header className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-canvas shadow-[0_0_0_1px_var(--color-hairline)]">
          <ProviderIcon provider={p.id} className={`size-6 ${installedNow ? "" : "opacity-40 grayscale"}`} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">{p.name}</h3>
            <Chip tone={chip.tone}>{chip.label}</Chip>
          </div>
          <p className="truncate text-[12px] text-text-muted">{p.vendor}</p>
        </div>
        {ctx.live && <HeaderAction p={p} status={status} env={ctx.env} />}
        {installedNow && <MoreMenu p={p} ctx={ctx} />}
      </header>
      {p.job && <JobStrip p={p} env={ctx.env} />}
      {installedNow ? (
        <Details p={p} env={ctx.env} />
      ) : p.job ? null : p.failure ? (
        <FailurePanel p={p} ctx={ctx} />
      ) : (
        <InstallPanel p={p} ctx={ctx} />
      )}
    </article>
  );
}

function HeaderAction({ p, status, env }: { p: ProviderMock; status: Status; env: EnvMock }) {
  if (p.job || p.failure) return null;
  if (status === "not-installed")
    return (
      <Button variant="primary" icon={ArrowDownToLineIcon} onClick={() => installProvider(p.id, env.id)}>
        Install
      </Button>
    );
  if (status === "signed-out")
    return (
      <Button variant="primary" icon={LogInIcon} onClick={() => signIn(p.id, env.id)}>
        Sign in
      </Button>
    );
  if (status === "update")
    return (
      <Button icon={ArrowDownToLineIcon} onClick={() => updateProvider(p.id, env.id)}>
        Update
      </Button>
    );
  return null;
}

function JobStrip({ p, env }: { p: ProviderMock; env: EnvMock }) {
  const job = p.job!;
  if (job.kind === "signin")
    return (
      <div className="flex items-center gap-3 rounded-xl bg-warning/10 px-3.5 py-3">
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-warning motion-reduce:animate-none" />
        <div className="min-w-0 flex-1">
          {job.code ? (
            <>
              <p>
                Enter <span className="font-mono font-semibold tracking-wider">{job.code}</span> at {p.signInAt}/device
              </p>
                          </>
          ) : (
            <>
              <p>Finish signing in on {p.signInAt}</p>
            </>
          )}
        </div>
        {job.code && <CopyButton text={job.code} label="Copy code" />}
        <Button variant="ghost" className="h-7 text-[12px]" onClick={() => toast(`Opened ${p.signInAt}`, "info")}>
          Reopen
        </Button>
        <Button variant="ghost" className="h-7 text-[12px]" onClick={() => cancelJob(p.id, env.id)}>
          Cancel
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-canvas px-3.5 py-3 shadow-[0_0_0_1px_var(--color-hairline)]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p>
            {job.step}
            <span className="text-text-muted">…</span>
          </p>
          {job.kind === "install" && (
            <p className="truncate font-mono text-[11px] text-text-muted">
              {env.kind === "local" ? "" : `${env.name} $ `}
              {p.install[p.method]}
            </p>
          )}
        </div>
        <span className="text-[12px] text-text-muted tabular-nums">{Math.round(job.progress * 100)}%</span>
        <IconButton icon={XIcon} label="Cancel" title="Cancel" className="size-7" onClick={() => cancelJob(p.id, env.id)} />
      </div>
      <ProgressBar value={job.progress} />
    </div>
  );
}

function Details({ p, env }: { p: ProviderMock; env: EnvMock }) {
  const local = env.kind === "local";
  return (
    <dl className="ml-[52px] border-t border-hairline [&>*+*]:border-t [&>*+*]:border-hairline">
      <Fact label="Account">
        {p.account ? (
          <>
            <span className="min-w-0 truncate">{p.account.email}</span>
            <Chip tone="neutral" dot={false}>
              {p.account.plan}
            </Chip>
          </>
        ) : (
          <span className="text-text-muted">
            Not signed in
          </span>
        )}
      </Fact>
      <Fact label="Version">
        <span className="tabular-nums">{p.version}</span>
        {p.version !== p.latest ? (
          <span className="text-[12px] text-info">{p.latest} available</span>
        ) : (
          <span className="text-[12px] text-text-muted">Latest</span>
        )}
      </Fact>
      <Fact
        label="Binary"
        end={
          <>
            <CopyButton text={p.path ?? ""} label="Copy path" />
            {local ? (
              <IconButton
                icon={FolderSearchIcon}
                label="Reveal in Finder"
                title="Reveal in Finder"
                className="size-7"
                onClick={() => toast(`Revealed ${p.binary}`, "info")}
              />
            ) : (
              <IconButton
                icon={SquareTerminalIcon}
                label={`Open a terminal on ${env.name}`}
                title={`Open a terminal on ${env.name}`}
                className="size-7"
                onClick={() => toast(`Opened a terminal on ${env.name}`, "info")}
              />
            )}
          </>
        }
      >
        <span className="min-w-0 truncate font-mono text-[12px]" data-selectable>
          {p.path}
        </span>
      </Fact>
    </dl>
  );
}

function Fact({ label, end, children }: { label: string; end?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid min-h-10 grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 py-1">
      <dt className="text-[12px] text-text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">{children}</dd>
      <div className="flex items-center gap-0.5">{end}</div>
    </div>
  );
}

/** The command as it will run: on a remote, behind the machine it runs on. */
function CommandLine({ p, env, command }: { p: ProviderMock; env: EnvMock; command?: string }) {
  const text = command ?? p.install[p.method] ?? "";
  const remote = env.kind !== "local";
  const full = remote ? `ssh ${env.ssh ?? env.name} '${text}'` : text;
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg bg-canvas pr-1 pl-3 shadow-[0_0_0_1px_var(--color-hairline)]">
      <TerminalIcon className="size-3.5 shrink-0 text-icon" />
      {remote && <span className="shrink-0 font-mono text-[12px] text-text-muted">{env.name} $</span>}
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]" data-selectable>
        {text}
      </code>
      <CopyButton text={full} label="Copy command" />
    </div>
  );
}

/** How it would install: the command, and the way to run it when there are several. The Install button is in the header. */
function InstallPanel({ p, ctx }: { p: ProviderMock; ctx: Ctx }) {
  const { env } = ctx;
  const methods = Object.keys(p.install) as InstallMethod[];
  return (
    <div className="flex items-center gap-2 pl-[52px]">
      <div className="min-w-0 flex-1">
        <CommandLine p={p} env={env} />
      </div>
      {methods.length > 1 && (
        <Segmented<InstallMethod>
          label="Install with"
          value={p.method}
          onChange={(method) => setMethod(p.id, method, env.id)}
          options={methods.map((m) => ({ value: m, label: METHOD_LABELS[m] }))}
        />
      )}
    </div>
  );
}

/** An install that stopped: ssh's words, what they mean, and the way past it. */
function FailurePanel({ p, ctx }: { p: ProviderMock; ctx: Ctx }) {
  const { env, live } = ctx;
  const failure = p.failure!;
  const script = p.install.script && p.method !== "script";
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-danger/6 p-1.5 ring-1 ring-danger/15">
      <div className="flex items-start gap-3 px-2 pt-2">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p>Install failed</p>
          <p className="mt-0.5 font-mono text-[11.5px] break-words text-danger" data-selectable>
            {failure.message}
          </p>
          <p className="mt-1.5 text-[12px] text-text-muted">{failure.hint}</p>
        </div>
        <IconButton icon={XIcon} label="Dismiss" title="Dismiss" className="size-7" onClick={() => dismissFailure(p.id, env.id)} />
      </div>
      {failure.fix && <CommandLine p={p} env={env} command={failure.fix.command} />}
      <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
        {script && (
          <Button variant="ghost" className="h-7 text-[12px]" onClick={() => setMethod(p.id, "script", env.id)}>
            Use script
          </Button>
        )}
        <Button variant="ghost" className="h-7 text-[12px]" disabled={!live} onClick={() => installProvider(p.id, env.id)}>
          Try again
        </Button>
        {failure.fix && (
          <Button variant="primary" icon={ArrowDownToLineIcon} disabled={!live} onClick={() => installWithNode(p.id, env.id)}>
            {failure.fix.label}
          </Button>
        )}
      </div>
    </div>
  );
}

function MoreMenu({ p, ctx }: { p: ProviderMock; ctx: Ctx }) {
  const { env, live } = ctx;
  const local = env.id === LOCAL_ENV;
  return (
    <Menu.Root>
      <Menu.Trigger
        render={<IconButton icon={EllipsisIcon} label={`More for ${p.name}`} className="data-popup-open:bg-hover" />}
      />
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            {local ? (
              <Menu.Item className={ROW} onClick={() => toast(`Revealed ${p.binary}`, "info")}>
                <FolderSearchIcon className="size-4 text-icon" />
                Reveal in Finder
              </Menu.Item>
            ) : (
              <Menu.Item className={`${ROW} data-disabled:opacity-40`} disabled={!live} onClick={() => toast(`Opened a terminal on ${env.name}`, "info")}>
                <SquareTerminalIcon className="size-4 text-icon" />
                Open terminal
              </Menu.Item>
            )}
            <Menu.Item className={`${ROW} data-disabled:opacity-40`} disabled={!live} onClick={() => installProvider(p.id, env.id)}>
              <RefreshCwIcon className="size-4 text-icon" />
              Reinstall
            </Menu.Item>
            {p.account && (
              <Menu.Item className={`${ROW} data-disabled:opacity-40`} disabled={!live} onClick={() => signOut(p.id, env.id)}>
                <LogOutIcon className="size-4 text-icon" />
                Sign out
              </Menu.Item>
            )}
            <Menu.Separator className="mx-2 my-1 h-px bg-hairline" />
            <Menu.Item className={`${ROW} text-danger data-disabled:opacity-40`} disabled={!live} onClick={() => uninstall(p.id, env.id)}>
              <Trash2Icon className="size-4" />
              Uninstall
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
