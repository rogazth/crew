// MOCKUP: Install, picking one way from two cards: In Crew or Per provider,
// never both. In Crew is the vault's install, one sign-in shared by
// every session in Crew on all your machines, run as connect.tsx runs it. Per
// provider is each CLI's own config, for using it outside Crew: its chips show
// under the control, a line per machine when there are several, and each signs
// in on its own (copies.ts, timers). A server that refuses Crew's sign-in opens
// on Per provider, with In Crew turned off.
import { CheckIcon, TerminalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CrewGlyph } from "../../../chrome/CrewGlyph";
import { EnvGlyph } from "../../../chrome/EnvBits";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { Button } from "../../../chrome/kit";
import { useEnvLinks } from "../../../hooks/useEnvLinks";
import { LOCAL, type EnvLink } from "../../../lib/client/registry";
import type { RegistryServer } from "../../../lib/protocol";
import { AccountName, RowAction } from "./bits";
import { brandOf, brandOfServer, type Brand } from "./brand";
import { CONFIG, installed, mock, same, useCopies, type Copy } from "./copies";
import { Dialog, DialogBody, DialogFooter, DialogGroup, DialogHeader, DialogRow } from "./dialog";
import { hostOf, ui } from "./lib";
import { ServiceMark } from "./mark";
import { PROVIDER_ORDER, providerName } from "./servers";
import { accountOfFlow, actions, connectorOf, refusalOf, useIntegrations, type FlowStage } from "./store";

const STAGE: Record<"opening" | "waiting" | "redeeming", string> = {
  opening: "Opening the sign-in window…",
  waiting: "Waiting for the browser…",
  redeeming: "Saving to the vault…",
};

/** Crew's install and sign-in, as connect.tsx runs them, started on demand. */
function useCrewRun(server: RegistryServer) {
  const s = useIntegrations();
  const [made, setMade] = useState<{ connectorId: string; flowId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const connector = connectorOf(s, made?.connectorId);
  const brand: Brand = connector ? brandOf(connector) : brandOfServer(server);
  const flow = s.flows.find((f) => f.id === made?.flowId);
  const account = accountOfFlow(s, made?.flowId);
  const connected = account?.state === "connected" && (!flow || flow.stage === "done") ? account : null;
  const stage: FlowStage | "idle" = !asked ? "idle" : connected ? "done" : error || flow?.stage === "failed" ? "failed" : (flow?.stage ?? "opening");
  const start = async () => {
    setAsked(true);
    setError(null);
    try {
      const next = await actions.installAndConnect({ kind: "registry", server });
      if (next.installed) ui.hide(next.connectorId);
      setMade({ connectorId: next.connectorId, flowId: next.flowId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  // Closed mid-way, the sign-in goes on and its tile shows it; failed, nothing lands.
  const close = () => (!made ? ui.close() : stage === "failed" ? ui.drop(made.connectorId) : ui.land(made.connectorId));
  return { brand, stage, connected, why: error ?? flow?.error, start, close };
}

function CrewMark({ size = "size-8" }: { size?: string }) {
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-[26%] bg-surface shadow-[0_0_0_1px_var(--color-hairline)]`}>
      <CrewGlyph className="w-[62%]" />
    </span>
  );
}

const Shimmer = ({ children }: { children: ReactNode }) => <span className="crew-shimmer">{children}</span>;

const COPY_LINE: Record<Copy["state"], string> = {
  adding: "Adding to its config…",
  "needs-auth": "Needs sign-in",
  "signing-in": "Waiting for the browser…",
  connected: "Signed in",
};

/** A provider's copy as a row: its state, and Authenticate when it waits on one. */
function CopyRow({ copy }: { copy: Copy }) {
  const working = copy.state === "adding" || copy.state === "signing-in";
  return (
    <DialogRow
      icon={<ProviderIcon provider={copy.provider} className="mx-2 size-4" />}
      title={providerName(copy.provider)}
      subtitle={
        working ? (
          <Shimmer>{COPY_LINE[copy.state]}</Shimmer>
        ) : (
          <span className={copy.state === "needs-auth" ? "text-warning" : ""}>
            {COPY_LINE[copy.state]} · {CONFIG[copy.provider]}
          </span>
        )
      }
    >
      {copy.state === "needs-auth" && <RowAction label="Authenticate" onClick={() => mock.signIn(copy)} />}
      {copy.state === "connected" && <CheckIcon className="mr-2 size-4 text-success" />}
    </DialogRow>
  );
}

/** Crew's run as one row: the stage, the failure with Try again, or the account. */
function CrewRow({ run }: { run: ReturnType<typeof useCrewRun> }) {
  const { stage, connected } = run;
  if (stage === "done" && connected)
    return (
      <DialogRow icon={<CrewMark />} title={<AccountName account={connected} />} subtitle={connected.identity ?? "Every Crew session gets it"}>
        <CheckIcon className="mr-2 size-4 text-success" />
      </DialogRow>
    );
  if (stage === "failed")
    return (
      <DialogRow icon={<CrewMark />} title="Crew" subtitle={<span className="text-danger">Sign-in didn’t finish{run.why ? ` · ${run.why}` : ""}</span>}>
        <RowAction label="Try again" onClick={() => void run.start()} />
      </DialogRow>
    );
  return <DialogRow icon={<CrewMark />} title="Crew" subtitle={<Shimmer>{STAGE[stage === "idle" || stage === "done" ? "opening" : stage]}</Shimmer>} />;
}

const header = (brand: Brand, server: RegistryServer, title: string, subtitle?: string) => (
  <DialogHeader mark={<ServiceMark brand={brand} size={40} />} title={title} subtitle={subtitle ?? `By ${server.publisher} · ${hostOf(server.remoteUrl) || server.remoteUrl}`} />
);

/* ── The sheet ──────────────────────────────────────────────────────── */

type Way = "crew" | "providers";

/** A way to install, as a radio card: its mark, its name and what it means, with why when it can't be picked. */
function WayCard({ icon, title, hint, on, disabled, onPick }: { icon: ReactNode; title: string; hint: string; on: boolean; disabled?: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onPick}
      className={`group flex flex-col gap-2.5 rounded-xl p-3 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-default ${
        on ? "bg-card shadow-[inset_0_0_0_1.5px_var(--color-text)]" : "bg-card enabled:hover:bg-hover"
      }`}
    >
      <span className={`flex items-center justify-between ${disabled ? "opacity-50" : ""}`}>
        {icon}
        <span className={`grid size-4 place-items-center rounded-full transition-colors ${on ? "bg-text text-inverse" : "ring-1 ring-border-strong group-disabled:opacity-0"}`}>
          {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`truncate font-medium ${disabled ? "text-text-muted" : ""}`}>{title}</span>
        {/* Two lines, always: the cards stay the same height whatever they say. */}
        <span className="line-clamp-2 min-h-[2lh] text-[12px] text-text-muted">{hint}</span>
      </span>
    </button>
  );
}

/** One provider to pick, as a chip: faded behind a dashed edge until picked, then full and outlined in the accent; one that already has it shows full with a quiet solid edge, one that isn't there fades further. The edge is always the same width, so picking never moves the row. */
function ProviderChip({ provider, on, state, onToggle }: { provider: string; on: boolean; state: "open" | "has" | "missing"; onToggle: () => void }) {
  const look = on
    ? "border-accent"
    : state === "has"
      ? "border-border-strong"
      : state === "missing"
        ? "border-dashed border-border-strong opacity-30"
        : "border-dashed border-border-strong opacity-55 hover:opacity-85";
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={state !== "open"}
      title={state === "has" ? "Already has it" : state === "missing" ? "Not installed there" : undefined}
      onClick={onToggle}
      className={`flex h-8 items-center gap-1.5 rounded-full border-[1.5px] bg-card pr-3 pl-2 text-[12.5px] text-text outline-none transition-[opacity,border-color] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 ${look}`}
    >
      <ProviderIcon provider={provider} className={`size-4 ${state === "missing" ? "grayscale" : ""}`} />
      {providerName(provider)}
    </button>
  );
}

/** A machine a provider can be on: the real links, and with ?machines=2 a made-up second one (MOCKUP), to see the sheet with several. */
type Machine = { id: string; name: string; link: EnvLink | null };

const DEVBOX: EnvLink = { id: "proto-devbox", name: "dev-box", status: "online" } as EnvLink;

function useMachines(two: boolean): Machine[] {
  const links = useEnvLinks();
  const real: Machine[] = links.length ? links.map((l) => ({ id: l.id, name: l.name, link: l })) : [{ id: LOCAL, name: "This Mac", link: null }];
  return two && real.length === 1 ? [...real, { id: DEVBOX.id, name: DEVBOX.name, link: DEVBOX }] : real;
}

const pick = (envId: string, provider: string) => `${envId}\u0000${provider}`;

export function InstallDialog({ server }: { server: RegistryServer }) {
  const twoMachines = new URLSearchParams(location.search).get("machines") === "2";
  const url = server.remoteUrl;
  const refused = refusalOf(server.name);
  const crew = useCrewRun(server);
  const machines = useMachines(twoMachines);
  const copies = useCopies();
  const [way, setWay] = useState<Way>(refused ? "providers" : "crew");
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState<string[] | null>(null);
  const name = crew.brand.name;
  const has = (envId: string, provider: string) => copies.some((c) => same(c, { url, envId, provider }));
  const stateOf = (envId: string, provider: string) => (!installed(envId, provider) ? "missing" : has(envId, provider) ? "has" : "open");
  const chosen = picked.filter((k) => {
    const [envId, provider] = k.split("\u0000") as [string, string];
    return machines.some((m) => m.id === envId) && stateOf(envId, provider) === "open";
  });
  const many = machines.length > 1;
  const inCrew = crew.stage === "done";

  if (sent) {
    const mine = copies.filter((c) => c.url === url && sent.includes(pick(c.envId, c.provider)));
    const done = mine.length === sent.length && mine.every((c) => c.state === "connected");
    const envs = machines.filter((m) => mine.some((c) => c.envId === m.id));
    return (
      <Dialog label={`Add ${name} to providers`}>
        {header(crew.brand, server, done ? `${name} is in your providers` : `Adding ${name}`, "Outside Crew")}
        <DialogBody>
          {envs.map((m) => (
            <DialogGroup key={m.id} {...(many ? { title: m.name } : {})}>
              {mine
                .filter((c) => c.envId === m.id)
                .map((c) => (
                  <CopyRow key={c.provider} copy={c} />
                ))}
            </DialogGroup>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant={done ? "primary" : "ghost"} onClick={crew.close}>
            {done ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  // Crew's sign-in running, failed or done.
  if (crew.stage !== "idle") {
    const done = crew.stage === "done";
    return (
      <Dialog label={`Install ${name}`}>
        {header(crew.brand, server, done ? `${name} is installed` : `Installing ${name}`, done ? (crew.connected?.identity ?? server.publisher) : undefined)}
        <DialogGroup {...(done ? { title: "Account" } : {})}>
          <CrewRow run={crew} />
        </DialogGroup>
        <DialogFooter>
          <Button variant={done ? "primary" : "ghost"} onClick={crew.close}>
            {done ? "Done" : crew.stage === "failed" ? "Cancel" : "Close"}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  const crewLocked = !!refused || inCrew;
  const toggle = (key: string) => setPicked((x) => (x.includes(key) ? x.filter((y) => y !== key) : [...x, key]));
  return (
    <Dialog label={`Install ${name}`}>
      {header(crew.brand, server, `Install ${name}`)}
      <DialogBody>
        {server.description && <p className="px-5 pb-4 text-[13px] text-text-muted">{server.description}</p>}
        <div role="radiogroup" aria-label="How to install" className="grid grid-cols-2 gap-2 px-5 pb-5">
          <WayCard
            icon={<CrewGlyph className="size-4" />}
            title="In Crew"
            hint={refused ? "This server doesn’t support Crew’s sign-in." : inCrew ? "Already installed." : "Sign in once. Every session on every machine gets it."}
            on={way === "crew"}
            disabled={crewLocked}
            onPick={() => setWay("crew")}
          />
          <WayCard
            icon={<TerminalIcon className="size-4 text-icon" />}
            title="Per provider"
            hint="Each CLI gets its own copy and its own sign-in."
            on={way === "providers"}
            onPick={() => setWay("providers")}
          />
        </div>
        {/* Picked, the providers show under the cards: one line of chips, a line per machine when there are several. */}
        {way === "providers" && (
          <div className="flex flex-col gap-3 px-5 pb-5">
            {machines.map((m) => (
              <div key={m.id} className="flex flex-col gap-2">
                {many && (
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-text-muted">
                    <EnvGlyph link={m.link} className="size-3.5" />
                    {m.name}
                  </span>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {PROVIDER_ORDER.map((provider) => {
                    const key = pick(m.id, provider);
                    return <ProviderChip key={provider} provider={provider} state={stateOf(m.id, provider)} on={chosen.includes(key)} onToggle={() => toggle(key)} />;
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={ui.close}>
          Cancel
        </Button>
        {way === "crew" ? (
          <Button variant="primary" disabled={crewLocked} onClick={() => void crew.start()}>
            Install
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={chosen.length === 0}
            onClick={() => {
              for (const m of machines) {
                const providers = chosen.filter((k) => k.startsWith(`${m.id}\u0000`)).map((k) => k.split("\u0000")[1]!);
                if (providers.length) mock.add(url, m.id, providers);
              }
              setSent(chosen);
              setPicked([]);
            }}
          >
            {chosen.length > 1 ? `Add to ${chosen.length} providers` : "Add"}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
