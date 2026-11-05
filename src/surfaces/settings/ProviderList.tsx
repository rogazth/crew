// Providers' lower half: the CLIs on one machine. A picker at the top says
// which machine (this Mac or a remote); each machine has its own installs,
// versions and sign-ins, and an install on a remote runs there over SSH.
// Everything here is the machine's own answer: crewd reads the CLIs and runs
// the jobs, and signing in happens in a terminal on that machine (Codex also
// has a device code shown here).
import { Menu } from "@base-ui/react/menu";
import {
  ArrowDownToLineIcon,
  CircleAlertIcon,
  EllipsisIcon,
  FolderSearchIcon,
  LoaderCircleIcon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { EnvGlyph } from "../../chrome/EnvBits";
import { Button, FilterChip, IconButton, PANEL, ROW } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useEnvLinks } from "../../hooks/useEnvLinks";
import { useProviderJobs } from "../../hooks/useProviderJobs";
import { refreshProvider, useProviderStatus } from "../../hooks/useProviderStatus";
import { LOCAL, reconnect, type EnvLink } from "../../lib/client/registry";
import { filesHost, openUrl, remotesHost } from "../../lib/host";
import type { ProviderJob, ProviderJobMethod, ProviderStatus } from "../../lib/protocol";
import { PROVIDERS, providerOf, type ProviderId } from "../../lib/providers";
import { errorText } from "../../lib/remotes";
import { PROVIDER_META } from "./providerMeta";
import { setProvidersEnv, useProvidersEnv } from "./route";
import { RowAction } from "./integrations/bits";
import { Callout, ConfirmDialog, CopyButton, Heading, Notice, toast, type ConfirmAsk } from "./ui";

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

/** What a card's icon says with a dot; all well says nothing. */
const DOTS: Partial<Record<Status, { ink: string; label: string }>> = {
  update: { ink: "bg-info", label: "Update available" },
  "signed-out": { ink: "bg-warning", label: "Signed out" },
  "can't-run": { ink: "bg-warning", label: "Can't run" },
  failed: { ink: "bg-danger", label: "Failed" },
};

/** What a card does on its machine: everything, or only look while it is unreachable. */
type Ctx = {
  link: EnvLink;
  live: boolean;
  jobs: ReturnType<typeof useProviderJobs>;
  /** CLIs whose job ended and whose new state the machine has not answered with yet. */
  settling: ReadonlySet<string>;
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
    ask: setAsk,
    onOpenTerminal,
    refresh: () => void refresh(),
  };

  const rows = PROVIDERS.map((def) => ({ id: def.id, status: status.providers?.find((p) => p.id === def.id) })).filter(
    (row): row is { id: ProviderId; status: ProviderStatus } => row.status !== undefined,
  );
  // A card appears once its install starts, and stays through a failure until it is dismissed.
  const visible = (id: string, installed: boolean) =>
    installed || settling.has(id) || jobs.jobs[id]?.phase === "running" || jobs.jobs[id]?.phase === "failed";
  const shown = rows.filter((r) => visible(r.id, r.status.installed));
  const offered = rows.filter((r) => !visible(r.id, r.status.installed));
  const loaded = status.providers !== null;
  const check = () =>
    void refresh().then((found) => {
      if (!found) return toast(`Couldn't reach ${link.name}`, "danger");
      const updates = found.filter((p) => p.installed && p.updateAvailable).length;
      toast(updates === 0 ? "All up to date" : `${updates} update${updates === 1 ? "" : "s"} available`, updates === 0 ? "success" : "info");
    });
  // With no other machine there is nothing to choose between.
  const several = links.length > 1;
  const actions = (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" icon={RefreshCwIcon} loading={status.loading} disabled={!live} onClick={check}>
        Check updates
      </Button>
      {offered.length > 0 && <InstallMenu rows={offered} ctx={ctx} />}
    </div>
  );
  const empty = loaded && shown.length === 0;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {loaded && !empty && <Heading title="Installed" {...(several ? {} : { action: <div className="-mr-2.5">{actions}</div> })} />}
        {several && (
          <div data-setting="providers-env" className="flex items-center justify-between gap-3">
            <EnvPicker link={link} links={links} />
            {loaded && !empty && actions}
          </div>
        )}
        {!live && <Unreachable link={link} />}
        {!loaded ? (
          <p className="rounded-xl bg-card px-4 py-5 text-center text-text-muted">
            {live || link.status === "connecting" ? "Checking what is installed…" : `Can't read ${link.name} while it is away.`}
          </p>
        ) : empty ? (
          <div className={`flex flex-col gap-1 ${several ? "items-start py-4" : "items-center py-12 text-center"}`}>
            <div className="mb-2 flex items-center gap-1.5">
              {rows.map((r) => (
                <span key={r.id} className="grid size-8 place-items-center rounded-lg bg-card">
                  <ProviderIcon provider={r.id} className="size-5" />
                </span>
              ))}
            </div>
            <p className="text-[14px] font-medium">No agents installed</p>
            <p className="text-text-muted">Install one to start working on {hereOf(link)}.</p>
            <div className="mt-2.5">
              <InstallMenu rows={offered} ctx={ctx} primary />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((r) => (
              <ProviderCard key={r.id} id={r.id} p={r.status} ctx={ctx} />
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </section>
  );
}

const RUNNING = {
  install: "Installing",
  reinstall: "Reinstalling",
  update: "Updating",
  uninstall: "Uninstalling",
  logout: "Signing out",
} as const;

const DONE = {
  install: (name: string) => `${name} installed`,
  reinstall: (name: string) => `${name} reinstalled`,
  update: (name: string) => `${name} updated`,
  uninstall: (name: string) => `${name} uninstalled`,
  logout: (name: string) => `Signed out of ${name}`,
} as const;

/* ── Which machine ──────────────────────────────────────────────────── */

/** Providers' and Connectors' share the machine they show (`setProvidersEnv`); `align="end"` when it ends its line. */
export function EnvPicker({ link, links, align }: { link: EnvLink; links: EnvLink[]; align?: "start" | "end" }) {
  return (
    <FilterChip
      label="Machine"
      value={link.id}
      onChange={setProvidersEnv}
      {...(align ? { align } : {})}
      options={links.map((l) => ({
        value: l.id,
        label: l.status === "offline" ? `${l.name} (offline)` : l.name,
        icon: <EnvGlyph link={l} className="size-3.5" />,
      }))}
    />
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
        title="Update available"
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
  const dot = DOTS[status];
  const running = job?.phase === "running";
  const failed = job?.phase === "failed" ? job : undefined;
  const codexFlow = id === "codex" && ctx.jobs.flow ? ctx.jobs.flow : null;
  const account = p.installed && p.account?.signedIn ? p.account : null;
  const version = p.installed ? p.version : undefined;
  const note = running ? undefined : p.note;
  return (
    // A filled card on the page, its facts straight on it: no shadow, no second ground inside.
    <article data-setting={`provider-${id}`} className="flex flex-col gap-2.5 rounded-xl bg-card p-3">
      <header className="flex items-center gap-3">
        <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-canvas shadow-[0_0_0_1px_var(--color-hairline)]">
          <ProviderIcon provider={id} className={`size-5 ${p.installed ? "" : "opacity-40 grayscale"}`} />
          {dot && (
            <span
              role="img"
              aria-label={dot.label}
              title={dot.label}
              className={`absolute -right-[2px] -bottom-[2px] size-2.5 rounded-full ring-2 ring-card ${dot.ink}`}
            />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-baseline gap-1">
            <h3 className="truncate leading-5 font-medium">{meta.name}</h3>
            {version && (
              <span className="shrink-0 text-[12px] text-text-muted tabular-nums">
                - Version{" "}
                {p.updateAvailable && p.latest ? (
                  <>
                    <s>{version}</s> → {p.latest}
                  </>
                ) : (
                  version
                )}
              </span>
            )}
          </div>
          <p className="truncate text-[12px] text-text-muted">
            {account ? `${account.email ?? "Signed in"}${account.plan ? ` (${account.plan})` : ""}` : meta.vendor}
          </p>
        </div>
        {(running || settling) && (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-muted">
            <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
            {running ? RUNNING[job.action] : "Checking"}
          </span>
        )}
        {ctx.live && !running && !settling && !failed && !codexFlow && <HeaderAction id={id} status={status} ctx={ctx} />}
        {p.installed && <MoreMenu id={id} p={p} ctx={ctx} busy={running || settling} />}
      </header>
      {codexFlow && <DeviceCode flow={codexFlow} ctx={ctx} />}
      {failed && <FailurePanel id={id} job={failed} p={p} ctx={ctx} />}
      {note && (
        <Notice icon={TriangleAlertIcon} ink="text-warning" title="Can't run">
          {note}
        </Notice>
      )}
    </article>
  );
}

/** The method an install or reinstall would use: the last used, else the first the machine has. */
function methodFor(id: string, p: ProviderStatus, ctx: Ctx): ProviderJobMethod | undefined {
  const usable: ProviderJobMethod[] = p.methods.filter((m) => m !== "native");
  const wanted = ctx.jobs.methodOf(id);
  return wanted && usable.includes(wanted) ? wanted : usable[0];
}

function fail(reason: unknown) {
  toast(errorText(reason), "danger");
}

function HeaderAction({ id, status, ctx }: { id: ProviderId; status: Status; ctx: Ctx }) {
  const { jobs } = ctx;
  if (status === "signed-out") return <RowAction label="Sign in" onClick={() => signIn(id, ctx)} />;
  if (status === "update") return <RowAction label="Update" onClick={() => void jobs.start(id, "update").catch(fail)} />;
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
  const { jobs } = ctx;
  void jobs.start(id, "logout").catch(fail);
}

function DeviceCode({ flow, ctx }: { flow: { userCode: string; verificationUrl: string }; ctx: Ctx }) {
  return (
    <Notice
      icon={LoaderCircleIcon}
      ink="text-icon"
      spinning
      title={
        <>
          Enter <span className="font-mono font-semibold tracking-wider">{flow.userCode}</span> to sign in
        </>
      }
      actions={
        <>
          <CopyButton text={flow.userCode} label="Copy code" />
          <Button variant="ghost" size="sm" onClick={() => void openUrl(flow.verificationUrl).catch(fail)}>
            Open
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void ctx.jobs.cancelLogin().catch(fail)}>
            Cancel
          </Button>
        </>
      }
    >
      {flow.verificationUrl}
    </Notice>
  );
}

/** The tool on the machine each method runs. */
const TOOL_OF: Record<ProviderJobMethod, string> = { npm: "npm", brew: "Homebrew", script: "curl", native: "itself" };

const orList = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** Pick an agent and it installs. One the machine has no tool for says what it needs instead. */
function InstallMenu({ rows, ctx, primary = false }: { rows: { id: ProviderId; status: ProviderStatus }[]; ctx: Ctx; primary?: boolean }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={!ctx.live}
        render={
          <Button variant={primary ? "primary" : "ghost"} size={primary ? "md" : "sm"} icon={PlusIcon}>
            Install an agent
          </Button>
        }
      />
      <Menu.Portal>
        <Menu.Positioner side="bottom" align={primary ? "start" : "end"} sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            {rows.map(({ id, status }) => {
              const method = methodFor(id, status, ctx);
              const meta = PROVIDER_META[id];
              const tools = Object.keys(meta.install).map((m) => TOOL_OF[m as ProviderJobMethod]);
              return (
                <Menu.Item
                  key={id}
                  disabled={!method}
                  className={`${ROW} h-11 data-disabled:opacity-40`}
                  onClick={() => method && void ctx.jobs.start(id, "install", method).catch(fail)}
                >
                  <ProviderIcon provider={id} className="size-5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{meta.name}</span>
                    <span className="truncate text-[11px] text-text-muted">{method ? meta.vendor : `Needs ${orList(tools)}`}</span>
                  </span>
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A job that stopped: what the machine said, and the ways past it. */
function FailurePanel({ id, job, p, ctx }: { id: ProviderId; job: ProviderJob; p: ProviderStatus; ctx: Ctx }) {
  const { jobs, live } = ctx;
  const verb = job.action === "logout" ? "Sign out" : job.action[0]!.toUpperCase() + job.action.slice(1);
  const script = job.action === "install" && job.method !== "script" && p.methods.includes("script");
  return (
    <Notice
      icon={CircleAlertIcon}
      ink="text-danger"
      title={`${verb} failed`}
      actions={
        <>
          {script && (
            <Button variant="ghost" size="sm" disabled={!live} onClick={() => void jobs.start(id, "install", "script").catch(fail)}>
              Use script
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={!live} onClick={() => void jobs.start(id, job.action, job.method).catch(fail)}>
            Try again
          </Button>
          <IconButton icon={XIcon} label="Dismiss" title="Dismiss" className="size-7" onClick={() => jobs.clear(id)} />
        </>
      }
    >
      {job.error ?? "The command did not finish."}
    </Notice>
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
