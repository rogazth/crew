// Providers' lower half: the CLIs on one machine. A picker at the top says
// which machine (this Mac or a remote); each machine has its own installs,
// versions and sign-ins, and an install on a remote runs there over SSH.
// Everything here is the machine's own answer: crewd reads the CLIs and runs
// the jobs, and signing in happens in a terminal on that machine (Codex also
// has a device code shown here).
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
  TriangleAlertIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ConnectionDot, ConnectionLabel, EnvGlyph } from "../../chrome/EnvBits";
import { Button, IconButton, PANEL, ROW, Segmented } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useEnvLinks } from "../../hooks/useEnvLinks";
import { useProviderJobs } from "../../hooks/useProviderJobs";
import { refreshProvider, useProviderStatus } from "../../hooks/useProviderStatus";
import { LOCAL, reconnect, type EnvLink } from "../../lib/client/registry";
import { filesHost, openUrl, remotesHost } from "../../lib/host";
import type { ProviderJob, ProviderJobMethod, ProviderStatus } from "../../lib/protocol";
import { PROVIDERS, providerOf, type ProviderId } from "../../lib/providers";
import { errorText } from "../../lib/remotes";
import { METHOD_LABELS, PROVIDER_META } from "./providerMeta";
import { setProvidersEnv, useProvidersEnv } from "./route";
import { Callout, Chip, ConfirmDialog, CopyButton, Heading, toast, type ConfirmAsk, type Tone } from "./ui";

type Props = {
  onOpenTerminal: (envId: string, input?: string) => Promise<void>;
  /** A job on any machine ended: the preferred-agent list asks again which CLIs are there. */
  onSettled: () => void;
};

type Status =
  | "installing"
  | "updating"
  | "removing"
  | "checking"
  | "failed"
  | "can't-run"
  | "not-installed"
  | "signed-out"
  | "update"
  | "ok";

const STATUS: Record<Status, { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "Up to date" },
  update: { tone: "info", label: "Update available" },
  "signed-out": { tone: "warning", label: "Signed out" },
  "not-installed": { tone: "neutral", label: "Not installed" },
  "can't-run": { tone: "warning", label: "Can't run" },
  failed: { tone: "danger", label: "Failed" },
  installing: { tone: "accent", label: "Installing" },
  updating: { tone: "accent", label: "Updating" },
  removing: { tone: "accent", label: "Working" },
  checking: { tone: "neutral", label: "Checking" },
};

/** What a card does on its machine: everything, or only look while it is unreachable. */
type Ctx = {
  link: EnvLink;
  live: boolean;
  jobs: ReturnType<typeof useProviderJobs>;
  /** CLIs whose job ended and whose new state the machine has not answered with yet. */
  settling: ReadonlySet<string>;
  /** The way each card will install, when it was not set before. */
  chosen: Partial<Record<string, ProviderJobMethod>>;
  choose: (provider: string, method: ProviderJobMethod) => void;
  ask: (ask: ConfirmAsk) => void;
  onOpenTerminal: Props["onOpenTerminal"];
  refresh: () => void;
};

/** "this Mac" or the machine's name, for sentences. */
const hereOf = (link: EnvLink) => (link.id === LOCAL ? "this Mac" : link.name);

function statusOf(p: ProviderStatus, job: ProviderJob | undefined, settling: boolean): Status {
  if (job?.phase === "running") {
    if (job.action === "install" || job.action === "reinstall") return "installing";
    if (job.action === "update") return "updating";
    return "removing";
  }
  if (job?.phase === "failed") return "failed";
  // The card still shows the state from before the job: no "Update" to press twice.
  if (settling) return "checking";
  if (!p.installed) return "not-installed";
  if (p.note) return "can't-run";
  if (p.account?.signedIn === false) return "signed-out";
  if (p.updateAvailable) return "update";
  return "ok";
}

export function ProviderList({ onOpenTerminal, onSettled }: Props) {
  const links = useEnvLinks();
  const viewing = useProvidersEnv();
  const link = links.find((l) => l.id === viewing) ?? links[0];
  if (!link) return null;
  return <Machine key={link.id} link={link} links={links} onOpenTerminal={onOpenTerminal} onSettled={onSettled} />;
}

function Machine({ link, links, onOpenTerminal, onSettled }: Props & { link: EnvLink; links: EnvLink[] }) {
  const status = useProviderStatus(link.id);
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  const [chosen, setChosen] = useState<Partial<Record<string, ProviderJobMethod>>>({});
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const live = link.status === "online" && !link.mismatch;
  const { refresh } = status;

  const jobs = useProviderJobs(link.id, (job) => {
    onSettled();
    // Only this CLI is asked again; the card says it is checking until the answer lands.
    const provider = job.provider;
    setSettling((all) => new Set(all).add(provider));
    void refreshProvider(link.id, provider).finally(() =>
      setSettling((all) => {
        const rest = new Set(all);
        rest.delete(provider);
        return rest;
      }),
    );
    const known = PROVIDER_META[provider as ProviderId];
    const name = known?.name ?? provider;
    if (job.phase === "done") toast(DONE[job.action](name));
  });
  const { loginEnd } = jobs;

  // A sign-in that ended in the device-code flow (Codex's) changes the account.
  useEffect(() => {
    if (!loginEnd) return;
    void refreshProvider(link.id, "codex");
    if (loginEnd.phase === "done") toast("Signed in");
    else if (loginEnd.phase === "failed") toast(loginEnd.error ?? "Sign-in failed", "danger");
  }, [loginEnd, link.id]);
  useEffect(() => {
    if (!live) return;
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [live, refresh]);

  const ctx: Ctx = {
    link,
    live,
    jobs,
    settling,
    chosen,
    choose: (provider, method) => setChosen((all) => ({ ...all, [provider]: method })),
    ask: setAsk,
    onOpenTerminal,
    refresh: () => void refresh(),
  };

  const rows = PROVIDERS.map((def) => ({ id: def.id, status: status.providers?.find((p) => p.id === def.id) })).filter(
    (row): row is { id: ProviderId; status: ProviderStatus } => row.status !== undefined,
  );
  // A card being installed stays where it was until the install lands.
  const ready = rows.filter((r) => r.status.installed);
  const available = rows.filter((r) => !r.status.installed);
  const local = link.id === LOCAL;

  const check = () =>
    void refresh().then((found) => {
      if (!found) return toast(`Couldn't reach ${link.name}`, "danger");
      const updates = found.filter((p) => p.installed && p.updateAvailable).length;
      toast(updates === 0 ? "All up to date" : `${updates} update${updates === 1 ? "" : "s"} available`, updates === 0 ? "success" : "info");
    });

  return (
    <section className="flex flex-col gap-4">
      <div data-setting="providers-env" className="flex items-center gap-3 px-1">
        <EnvPicker link={link} links={links} />
        <span className="flex-1" />
        {status.providers && (
          <span className="text-[12px] text-text-muted tabular-nums">
            {ready.length} of {rows.length} installed
          </span>
        )}
        <Button variant="ghost" icon={RefreshCwIcon} loading={status.loading} disabled={!live} onClick={check}>
          Check updates
        </Button>
      </div>
      {!live && <Unreachable link={link} />}
      {status.providers === null ? (
        <p className="rounded-xl bg-card px-4 py-5 text-center text-text-muted">
          {live || link.status === "connecting" ? "Checking what is installed…" : `Can't read ${link.name} while it is away.`}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <Heading title="Installed" />
            {ready.length === 0 ? (
              <p className="rounded-xl bg-card px-4 py-5 text-center text-text-muted">No agents installed on {hereOf(link)}.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {ready.map((r) => (
                  <ProviderCard key={r.id} id={r.id} p={r.status} ctx={ctx} />
                ))}
              </div>
            )}
          </div>
          {available.length > 0 && (
            <div className="flex flex-col gap-3">
              <Heading
                title={local ? "More agents" : `Not on ${link.name}`}
                {...(local ? {} : { description: `Installs on ${link.name} over SSH.` })}
              />
              <div className="flex flex-col gap-4">
                {available.map((r) => (
                  <ProviderCard key={r.id} id={r.id} p={r.status} ctx={ctx} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </section>
  );
}

const DONE = {
  install: (name: string) => `${name} installed`,
  reinstall: (name: string) => `${name} reinstalled`,
  update: (name: string) => `${name} updated`,
  uninstall: (name: string) => `${name} uninstalled`,
  logout: (name: string) => `Signed out of ${name}`,
} as const;

/* ── Which machine ──────────────────────────────────────────────────── */

/** A fixed-width trigger: picking a machine with a longer name never moves the row. */
function EnvPicker({ link, links }: { link: EnvLink; links: EnvLink[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Machine"
        className="flex h-9 w-60 items-center gap-2.5 rounded-lg bg-card pr-2 pl-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-hover"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-canvas text-icon">
          <EnvGlyph link={link} className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{link.name}</span>
        <ConnectionDot link={link} />
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-icon" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-text-muted">Machine</div>
            {links.map((l) => (
              <Menu.Item key={l.id} className={`${ROW} h-11`} onClick={() => setProvidersEnv(l.id)}>
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-card text-icon">
                  <EnvGlyph link={l} className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{l.name}</span>
                  <ConnectionLabel link={l} className="text-[11px]" />
                </span>
                <CheckIcon className={`size-4 shrink-0 ${l.id === link.id ? "" : "invisible"}`} />
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Unreachable({ link }: { link: EnvLink }) {
  const [updating, setUpdating] = useState(false);
  if (link.status === "connecting")
    return <Callout tone="neutral" icon={LoaderCircleIcon} spinning title={`Connecting to ${link.name}…`} />;
  if (link.mismatch) {
    const update = () => {
      setUpdating(true);
      const host = remotesHost();
      (host ? host.update(link.id) : Promise.reject(new Error("Updating a machine needs the Crew app")))
        .then((result) => toast(result.warning ?? `${link.name} updated`, result.warning ? "info" : "success"))
        .catch((reason: unknown) => toast(errorText(reason), "danger"))
        .finally(() => setUpdating(false));
    };
    return (
      <Callout
        tone="accent"
        icon={ArrowDownToLineIcon}
        title="Update available for crewd"
        description={`${link.name} runs ${link.version ?? "an older version"}; update it to keep working there.`}
        action={
          <Button variant="primary" loading={updating} onClick={update}>
            Update
          </Button>
        }
      />
    );
  }
  return (
    <Callout
      tone="neutral"
      icon={WifiOffIcon}
      title={`${link.name} is offline`}
      description={link.lastSeen ? `Last seen ${new Date(link.lastSeen).toLocaleString()}` : (link.error ?? undefined)}
      action={
        <Button icon={RefreshCwIcon} onClick={() => reconnect(link.id)}>
          Retry
        </Button>
      }
    />
  );
}

/* ── One provider ───────────────────────────────────────────────────── */

function ProviderCard({ id, p, ctx }: { id: ProviderId; p: ProviderStatus; ctx: Ctx }) {
  const meta = PROVIDER_META[id];
  const job = ctx.jobs.jobs[id];
  const settling = ctx.settling.has(id);
  const status = statusOf(p, job, settling);
  const chip = STATUS[status];
  const running = job?.phase === "running";
  const failed = job?.phase === "failed" ? job : undefined;
  const codexFlow = id === "codex" && ctx.jobs.flow ? ctx.jobs.flow : null;
  return (
    // A filled card on the page, its facts straight on it: no shadow, no second ground inside.
    <article data-setting={`provider-${id}`} className="flex flex-col gap-3 rounded-[14px] bg-card p-4">
      <header className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-canvas shadow-[0_0_0_1px_var(--color-hairline)]">
          <ProviderIcon provider={id} className={`size-6 ${p.installed ? "" : "opacity-40 grayscale"}`} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">{meta.name}</h3>
            <Chip tone={chip.tone}>{status === "failed" && p.installed ? "Last job failed" : chip.label}</Chip>
          </div>
          <p className="truncate text-[12px] text-text-muted">{meta.vendor}</p>
        </div>
        {ctx.live && !running && !failed && !codexFlow && <HeaderAction id={id} p={p} status={status} ctx={ctx} />}
        {p.installed && <MoreMenu id={id} p={p} ctx={ctx} busy={running || settling} />}
      </header>
      {codexFlow && <DeviceCode flow={codexFlow} ctx={ctx} />}
      {running && <JobStrip id={id} job={job} ctx={ctx} />}
      {failed && <FailurePanel id={id} job={failed} p={p} ctx={ctx} />}
      {p.note && !running && (
        <p className="ml-[52px] flex items-start gap-2 text-[12px] text-warning">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span data-selectable>{p.note}</span>
        </p>
      )}
      {p.installed ? (
        <Details p={p} ctx={ctx} />
      ) : running || failed || settling ? null : (
        <InstallPanel id={id} p={p} ctx={ctx} />
      )}
    </article>
  );
}

/** The method an install or reinstall would use: the one picked, else the last used, else the first the machine has. */
function methodFor(id: string, p: ProviderStatus, ctx: Ctx): ProviderJobMethod | undefined {
  const usable: ProviderJobMethod[] = p.methods.filter((m) => m !== "native");
  const wanted = ctx.chosen[id] ?? ctx.jobs.methodOf(id);
  return wanted && usable.includes(wanted) ? wanted : usable[0];
}

function fail(reason: unknown) {
  toast(errorText(reason), "danger");
}

function HeaderAction({ id, p, status, ctx }: { id: ProviderId; p: ProviderStatus; status: Status; ctx: Ctx }) {
  const { jobs } = ctx;
  if (status === "not-installed") {
    const method = methodFor(id, p, ctx);
    return (
      <Button
        variant="primary"
        icon={ArrowDownToLineIcon}
        disabled={!method}
        onClick={() => method && void jobs.start(id, "install", method).catch(fail)}
      >
        Install
      </Button>
    );
  }
  if (status === "signed-out")
    return (
      <Button variant="primary" icon={LogInIcon} onClick={() => signIn(id, ctx)}>
        Sign in
      </Button>
    );
  if (status === "update")
    return (
      <Button icon={ArrowDownToLineIcon} onClick={() => void jobs.start(id, "update").catch(fail)}>
        Update
      </Button>
    );
  return null;
}

/** Codex signs in here, with a device code; the others in a terminal on the machine, where their own login runs. */
function signIn(id: ProviderId, ctx: Ctx) {
  const { jobs, link } = ctx;
  if (id === "codex") {
    void jobs
      .startLogin()
      .then((flow) => openUrl(flow.verificationUrl))
      .catch(fail);
    return;
  }
  void jobs
    .loginCommand(id)
    .then(({ login }) => {
      // A browser login on a remote machine has nowhere to finish. `remoteLogin` prints a code instead.
      const command = link.id !== LOCAL ? (providerOf(id)?.remoteLogin ?? login) : login;
      return ctx.onOpenTerminal(link.id, command);
    })
    .catch(fail);
}

function signOut(id: ProviderId, ctx: Ctx) {
  const { jobs, link } = ctx;
  // opencode asks which account to leave; that wants a terminal.
  if (id === "opencode") {
    void jobs
      .loginCommand(id)
      .then(({ logout }) => ctx.onOpenTerminal(link.id, logout))
      .catch(fail);
    return;
  }
  void jobs.start(id, "logout").catch(fail);
}

function DeviceCode({ flow, ctx }: { flow: { userCode: string; verificationUrl: string }; ctx: Ctx }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-warning/10 px-3.5 py-3">
      <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-warning motion-reduce:animate-none" />
      <div className="min-w-0 flex-1">
        <p>
          Enter <span className="font-mono font-semibold tracking-wider">{flow.userCode}</span> at{" "}
          <span data-selectable>{flow.verificationUrl}</span>
        </p>
      </div>
      <CopyButton text={flow.userCode} label="Copy code" />
      <Button variant="ghost" className="h-7 text-[12px]" onClick={() => void openUrl(flow.verificationUrl).catch(fail)}>
        Open
      </Button>
      <Button variant="ghost" className="h-7 text-[12px]" onClick={() => void ctx.jobs.cancelLogin().catch(fail)}>
        Cancel
      </Button>
    </div>
  );
}

function JobStrip({ id, job, ctx }: { id: ProviderId; job: ProviderJob; ctx: Ctx }) {
  const last = job.lastLines.at(-1);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-canvas px-3.5 py-3 shadow-[0_0_0_1px_var(--color-hairline)]">
      <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-accent motion-reduce:animate-none" />
      <div className="min-w-0 flex-1">
        <p>
          {job.step ?? "Working"}
          <span className="text-text-muted">…</span>
        </p>
        {job.command && (
          <p className="truncate font-mono text-[11px] text-text-muted">
            {ctx.link.id === LOCAL ? "" : `${ctx.link.name} $ `}
            {job.command}
          </p>
        )}
        {last && <p className="truncate font-mono text-[11px] text-text-muted">{last}</p>}
      </div>
      <IconButton icon={XIcon} label="Cancel" title="Cancel" className="size-7" onClick={() => void ctx.jobs.cancel(id).catch(fail)} />
    </div>
  );
}

function Details({ p, ctx }: { p: ProviderStatus; ctx: Ctx }) {
  const { link } = ctx;
  const local = link.id === LOCAL;
  const reveal = filesHost()?.reveal;
  const account = p.account;
  return (
    <dl className="ml-[52px] border-t border-hairline [&>*+*]:border-t [&>*+*]:border-hairline">
      <Fact label="Account">
        {account?.signedIn ? (
          <>
            <span className="min-w-0 truncate">{account.email ?? "Signed in"}</span>
            {account.plan && (
              <Chip tone="neutral" dot={false}>
                {account.plan}
              </Chip>
            )}
          </>
        ) : (
          <span className="text-text-muted">{account?.signedIn === false ? "Not signed in" : "Unknown"}</span>
        )}
      </Fact>
      <Fact label="Version">
        <span className="tabular-nums">{p.version ?? "Unknown"}</span>
        {p.updateAvailable && p.latest ? (
          <span className="text-[12px] text-info">{p.latest} available</span>
        ) : p.latest ? (
          <span className="text-[12px] text-text-muted">Latest</span>
        ) : null}
      </Fact>
      {p.path && (
        <Fact
          label="Binary"
          end={
            <>
              <CopyButton text={p.path} label="Copy path" />
              {local && reveal ? (
                <IconButton
                  icon={FolderSearchIcon}
                  label="Reveal in Finder"
                  title="Reveal in Finder"
                  className="size-7"
                  onClick={() => void reveal(p.path!).catch(fail)}
                />
              ) : !local ? (
                <IconButton
                  icon={SquareTerminalIcon}
                  label={`Open a terminal on ${link.name}`}
                  title={`Open a terminal on ${link.name}`}
                  className="size-7"
                  disabled={!ctx.live}
                  onClick={() => void ctx.onOpenTerminal(link.id).catch(fail)}
                />
              ) : null}
            </>
          }
        >
          <span className="min-w-0 truncate font-mono text-[12px]" data-selectable>
            {p.path}
          </span>
        </Fact>
      )}
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

/** The command as it runs: on a remote, behind the machine it runs on. */
function CommandLine({ link, command }: { link: EnvLink; command: string }) {
  const remote = link.id !== LOCAL;
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg bg-canvas pr-1 pl-3 shadow-[0_0_0_1px_var(--color-hairline)]">
      <TerminalIcon className="size-3.5 shrink-0 text-icon" />
      {remote && <span className="shrink-0 font-mono text-[12px] text-text-muted">{link.name} $</span>}
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]" data-selectable>
        {command}
      </code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}

/** The tool on the machine each method runs. */
const TOOL_OF: Record<ProviderJobMethod, string> = { npm: "npm", brew: "Homebrew", script: "curl", native: "itself" };

const orList = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** How it would install: the command, and the way to run it when there are several. The Install button is in the header. */
function InstallPanel({ id, p, ctx }: { id: ProviderId; p: ProviderStatus; ctx: Ctx }) {
  const methods = p.methods.filter((m): m is "npm" | "brew" | "script" => m !== "native");
  const method = methodFor(id, p, ctx);
  if (!method) {
    const tools = Object.keys(PROVIDER_META[id].install).map((m) => TOOL_OF[m as ProviderJobMethod]);
    return (
      <p className="pl-[52px] text-[12px] text-text-muted">
        Nothing to install it with on {hereOf(ctx.link)}: it needs {orList(tools)}.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 pl-[52px]">
      <div className="min-w-0 flex-1">
        <CommandLine link={ctx.link} command={PROVIDER_META[id].install[method] ?? ""} />
      </div>
      {methods.length > 1 && (
        <Segmented<ProviderJobMethod>
          label="Install with"
          value={method}
          onChange={(next) => ctx.choose(id, next)}
          options={methods.map((m) => ({ value: m, label: METHOD_LABELS[m] }))}
        />
      )}
    </div>
  );
}

/** A job that stopped: what the machine said, the command that failed, and the ways past it. */
function FailurePanel({ id, job, p, ctx }: { id: ProviderId; job: ProviderJob; p: ProviderStatus; ctx: Ctx }) {
  const { jobs, live } = ctx;
  const verb = job.action === "logout" ? "Sign out" : job.action[0]!.toUpperCase() + job.action.slice(1);
  const script = job.action === "install" && job.method !== "script" && p.methods.includes("script");
  const output = job.lastLines.slice(-6).join("\n");
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-danger/6 p-1.5 ring-1 ring-danger/15">
      <div className="flex items-start gap-3 px-2 pt-2">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p>{verb} failed</p>
          <p className="mt-0.5 font-mono text-[11.5px] break-words text-danger" data-selectable>
            {job.error ?? "The command did not finish."}
          </p>
          {output && job.error !== output && (
            <pre className="mt-1.5 max-h-28 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-text-muted" data-selectable>
              {output}
            </pre>
          )}
        </div>
        <IconButton icon={XIcon} label="Dismiss" title="Dismiss" className="size-7" onClick={() => jobs.clear(id)} />
      </div>
      {job.command && <CommandLine link={ctx.link} command={job.command} />}
      <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
        {script && (
          <Button variant="ghost" className="h-7 text-[12px]" disabled={!live} onClick={() => void jobs.start(id, "install", "script").catch(fail)}>
            Use script
          </Button>
        )}
        <Button
          variant="ghost"
          className="h-7 text-[12px]"
          disabled={!live}
          onClick={() => void jobs.start(id, job.action, job.method).catch(fail)}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}

function MoreMenu({ id, p, ctx, busy }: { id: ProviderId; p: ProviderStatus; ctx: Ctx; busy: boolean }) {
  const { link, live, jobs } = ctx;
  const local = link.id === LOCAL;
  const reveal = filesHost()?.reveal;
  const off = !live || busy;
  const name = PROVIDER_META[id].name;
  const uninstall = () =>
    ctx.ask({
      title: `Uninstall ${name}?`,
      description: `This removes the CLI from ${hereOf(link)}. Sessions that use it cannot run until it is installed again.`,
      action: "Uninstall",
      onConfirm: () => void jobs.start(id, "uninstall").catch(fail),
    });
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton icon={EllipsisIcon} label={`More for ${name}`} className="data-popup-open:bg-hover" />} />
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            {local && reveal && p.path && (
              <Menu.Item className={ROW} onClick={() => void reveal(p.path!).catch(fail)}>
                <FolderSearchIcon className="size-4 text-icon" />
                Reveal in Finder
              </Menu.Item>
            )}
            <Menu.Item className={`${ROW} data-disabled:opacity-40`} disabled={!live} onClick={() => void ctx.onOpenTerminal(link.id).catch(fail)}>
              <SquareTerminalIcon className="size-4 text-icon" />
              Open terminal
            </Menu.Item>
            <Menu.Item
              className={`${ROW} data-disabled:opacity-40`}
              disabled={off}
              onClick={() => void jobs.start(id, "reinstall", methodFor(id, p, ctx)).catch(fail)}
            >
              <RefreshCwIcon className="size-4 text-icon" />
              Reinstall
            </Menu.Item>
            {p.account?.signedIn === true && (
              <Menu.Item className={`${ROW} data-disabled:opacity-40`} disabled={off} onClick={() => signOut(id, ctx)}>
                <LogOutIcon className="size-4 text-icon" />
                Sign out
              </Menu.Item>
            )}
            <Menu.Separator className="mx-2 my-1 h-px bg-hairline" />
            <Menu.Item className={`${ROW} text-danger data-disabled:opacity-40`} disabled={off} onClick={uninstall}>
              <Trash2Icon className="size-4" />
              Uninstall
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
