// PROTOTYPE — throwaway. Small pieces the Integrations variants may share: a
// service's monogram, state chips, the machine dots, and the sign-in "tab" that
// plays out a flow. Layout is each variant's own.
import { CheckIcon, KeyRoundIcon, LaptopIcon, LoaderCircleIcon, LockIcon, ServerIcon, VenetianMaskIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Chip, type Tone } from "../ui";
import {
  dismissFlow,
  machineOf,
  serviceOf,
  useIntegrations,
  type AccountState,
  type Flow,
  type Machine,
  type ServerState,
  type Service,
} from "./store.prototype";

/** Where a service's logo can come from: the registry's icon, then its publisher's favicon through Google's resolver. */
function logosOf(service: Service): string[] {
  const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(service.publisher)}&sz=128`;
  return service.logo ? [service.logo, favicon] : [favicon];
}

/** A service's tile: its real logo on paper when one loads, else a monogram on its hue; a hue of -1 is ink on paper. */
export function ServiceMark({ service, size = 32, className = "" }: { service: Service | undefined; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  if (!service) return <span className={`shrink-0 rounded-[28%] bg-fill ${className}`} style={{ width: size, height: size }} />;
  const logo = logosOf(service).find((src) => !failed.includes(src));
  if (logo) {
    const fail = () => setFailed((now) => [...now, logo]);
    return (
      <span
        aria-hidden
        className={`relative grid shrink-0 place-items-center overflow-hidden rounded-[26%] bg-white after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_oklch(0%_0_0/0.08)] ${className}`}
        style={{ width: size, height: size }}
      >
        <img
          src={logo}
          alt=""
          loading="lazy"
          className="size-full object-contain"
          onError={fail}
          // Google's resolver answers a miss with its own 16px globe, not a 404.
          onLoad={(event) => event.currentTarget.naturalWidth <= 16 && fail()}
        />
      </span>
    );
  }
  const neutral = service.hue < 0 || service.hue === 0;
  const style = neutral
    ? { width: size, height: size }
    : {
        width: size,
        height: size,
        background: `linear-gradient(160deg, oklch(70% 0.15 ${service.hue}), oklch(56% 0.17 ${service.hue}))`,
      };
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-[28%] font-semibold tracking-[-0.04em] shadow-[inset_0_0_0_1px_oklch(100%_0_0/0.12),0_1px_2px_oklch(0%_0_0/0.12)] select-none ${
        neutral ? "bg-text text-inverse" : "text-white"
      } ${className}`}
      style={{ ...style, fontSize: Math.round(size * (service.glyph.length > 1 ? 0.36 : 0.46)) }}
    >
      {service.glyph}
    </span>
  );
}

export const ACCOUNT_STATE: Record<AccountState, { tone: Tone; label: string }> = {
  connected: { tone: "success", label: "Signed in" },
  expired: { tone: "warning", label: "Needs authentication" },
  "needs-scope": { tone: "warning", label: "Needs access" },
  "lease-ending": { tone: "warning", label: "Lease ending" },
  "vault-offline": { tone: "danger", label: "Vault offline" },
};

export const SERVER_STATE: Record<ServerState, { tone: Tone; label: string }> = {
  connected: { tone: "success", label: "Connected" },
  "needs-auth": { tone: "info", label: "Needs sign-in" },
  failed: { tone: "danger", label: "Failed" },
  pending: { tone: "neutral", label: "Starting" },
};

export function AccountChip({ state }: { state: AccountState }) {
  const s = ACCOUNT_STATE[state];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export function ServerChip({ state, off }: { state: ServerState; off?: boolean }) {
  if (off) return <Chip tone="neutral" dot={false}>Off in Crew</Chip>;
  const s = SERVER_STATE[state];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export function MachineGlyph({ machine, className = "size-3.5" }: { machine: Machine; className?: string }) {
  const Glyph = machine.remote ? ServerIcon : LaptopIcon;
  return <Glyph className={className} />;
}

/** The vault as a small lit object: a lock in a ring, pulsing while it moves, struck while offline. */
export function VaultBadge({ className = "size-9" }: { className?: string }) {
  const s = useIntegrations();
  const tone = s.vault.state === "offline" ? "text-danger bg-danger/10" : s.vault.state === "moving" ? "text-warning bg-warning/12" : "text-success bg-success/12";
  return (
    <span className={`relative grid shrink-0 place-items-center rounded-full ${tone} ${className}`}>
      {s.vault.state === "moving" && <span className="absolute inset-0 rounded-full bg-current/15 motion-safe:animate-ping" />}
      <LockIcon className="size-[45%]" />
    </span>
  );
}

const STAGE_TEXT: Record<Flow["stage"], string> = {
  opening: "Opening the sign-in…",
  waiting: "Waiting for you in the tab",
  redeeming: "Signing in",
  done: "Signed in",
  failed: "The service refused Crew",
};

/**
 * One sign-in as a tiny browser window: the tab opens on the service's
 * consent page, the cursor presses Allow, the code travels to the machine
 * that holds the verifier, and the window turns into a check.
 */
export function SignInWindow({ flow, compact = false }: { flow: Flow; compact?: boolean }) {
  const s = useIntegrations();
  const service = serviceOf(flow.serviceId);
  const machine = machineOf(s, flow.machine);
  const vaultMove = flow.kind === "vault-move";
  const done = flow.stage === "done";
  return (
    <div className={`relative overflow-hidden rounded-xl bg-surface shadow-[0_0_0_1px_var(--color-hairline),0_12px_32px_-12px_oklch(0%_0_0/0.3)] ${compact ? "w-56" : "w-72"}`}>
      {/* Chrome */}
      <div className="flex h-7 items-center gap-1.5 border-b border-hairline px-2.5">
        <span className="size-2 rounded-full bg-[oklch(70%_0.18_25)]" />
        <span className="size-2 rounded-full bg-[oklch(80%_0.15_85)]" />
        <span className="size-2 rounded-full bg-[oklch(72%_0.17_145)]" />
        <span className="ml-1.5 flex h-4.5 min-w-0 flex-1 items-center gap-1 rounded bg-fill px-1.5 text-[10px] text-text-muted">
          {flow.incognito ? <VenetianMaskIcon className="size-2.5 shrink-0" /> : <LockIcon className="size-2.5 shrink-0" />}
          <span className="truncate">{vaultMove ? `${machine.name} · vault` : service?.host ?? "sign-in"}</span>
        </span>
        <button type="button" aria-label="Dismiss" onClick={() => dismissFlow(flow.id)} className="text-text-muted hover:text-text">
          <XIcon className="size-3" />
        </button>
      </div>
      {/* Page */}
      <div className={`relative grid place-items-center px-4 ${compact ? "h-24" : "h-32"}`}>
        {flow.stage === "opening" && (
          <div className="flex w-full flex-col gap-2 motion-safe:animate-pulse">
            <div className="h-2.5 w-1/2 rounded bg-fill" />
            <div className="h-2 w-3/4 rounded bg-fill" />
            <div className="h-2 w-2/3 rounded bg-fill" />
          </div>
        )}
        {flow.stage === "waiting" && !vaultMove && (
          <div className="flex w-full items-center gap-3 motion-safe:animate-[proto-rise_220ms_var(--ease-out)]">
            <ServiceMark service={service} size={compact ? 26 : 32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium">Allow Crew to use {service?.name}?</p>
              <p className="truncate text-[10px] text-text-muted">{flow.incognito ? "Sign in with another account" : "gabriel@acme.dev"}</p>
            </div>
            <span className="relative rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-inverse">
              Allow
              <span className="absolute -right-1.5 -bottom-2 size-3 rotate-[-20deg] motion-safe:animate-[proto-press_1.6s_ease-in-out_infinite]">
                <svg viewBox="0 0 12 12" className="size-3 drop-shadow"><path d="M1 1 L1 10 L3.6 7.6 L5.4 11 L7 10.2 L5.3 6.9 L8.6 6.9 Z" fill="white" stroke="black" strokeWidth="0.8" /></svg>
              </span>
            </span>
          </div>
        )}
        {(flow.stage === "redeeming" || (vaultMove && flow.stage === "waiting")) && (
          <div className="flex w-full items-center justify-center gap-3 text-[11px] text-text-muted">
            <KeyRoundIcon className="size-4 text-text motion-safe:animate-[proto-travel_700ms_var(--ease-out)_infinite]" />
            <span className="h-px w-14 bg-[repeating-linear-gradient(90deg,var(--color-border-strong)_0_4px,transparent_4px_8px)] motion-safe:animate-[proto-dash_600ms_linear_infinite]" />
            <span className="flex items-center gap-1.5 rounded-full bg-fill px-2 py-0.5 text-text">
              <MachineGlyph machine={machine} className="size-3" />
              {machine.name}
            </span>
          </div>
        )}
        {done && (
          <div className="flex flex-col items-center gap-1.5 motion-safe:animate-[proto-pop_360ms_var(--ease-spring)]">
            <span className="grid size-9 place-items-center rounded-full bg-success text-white">
              <CheckIcon className="size-5" strokeWidth={3} />
            </span>
          </div>
        )}
        {flow.stage === "failed" && <p className="text-center text-[11px] text-danger">{STAGE_TEXT.failed}</p>}
      </div>
      <div className="flex h-7 items-center gap-1.5 border-t border-hairline px-2.5 text-[11px] text-text-muted">
        {flow.stage === "redeeming" || flow.stage === "opening" ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
        <span className="truncate">{vaultMove ? (done ? `The vault is on ${machine.name}` : `Moving the vault to ${machine.name}`) : STAGE_TEXT[flow.stage]}</span>
      </div>
    </div>
  );
}

/** Every running sign-in, stacked at the bottom right like tabs waiting on you. */
export function FlowDock() {
  const s = useIntegrations();
  if (s.flows.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-6 bottom-20 z-[80] flex flex-col items-end gap-2">
      {s.flows.map((flow) => (
        <div key={flow.id} className="pointer-events-auto motion-safe:animate-[proto-rise_260ms_var(--ease-spring)]">
          <SignInWindow flow={flow} />
        </div>
      ))}
    </div>
  );
}

/** Rows that just changed glow once. */
export function useFresh(id: string): string {
  const s = useIntegrations();
  return s.fresh.includes(id) ? "motion-safe:animate-[proto-glow_1.4s_var(--ease-out)]" : "";
}

/** The keyframes the prototype's animations share. */
export function ProtoKeyframes() {
  return (
    <style>{`
      @keyframes proto-rise { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
      @keyframes proto-pop { 0% { opacity: 0; transform: scale(0.4); } 70% { transform: scale(1.08); } }
      @keyframes proto-press { 0%, 100% { transform: translate(0, 0) rotate(-20deg); } 45% { transform: translate(-1px, -1px) rotate(-20deg) scale(0.86); } }
      @keyframes proto-travel { from { transform: translateX(-6px); opacity: 0.4; } to { transform: translateX(4px); opacity: 1; } }
      @keyframes proto-dash { to { background-position: 8px 0; } }
      @keyframes proto-glow { 0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--color-success) 0%, transparent); background-color: color-mix(in oklab, var(--color-success) 14%, transparent); } 100% { background-color: transparent; } }
      @keyframes proto-fill { from { transform: scale(0); } }
      @keyframes proto-flow { to { stroke-dashoffset: -16; } }
    `}</style>
  );
}

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-medium tracking-[0.04em] text-text-muted uppercase">{children}</p>;
}
