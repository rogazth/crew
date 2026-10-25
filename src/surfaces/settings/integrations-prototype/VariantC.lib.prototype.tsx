// PROTOTYPE — throwaway. Variant C's own state and hooks: which sheet is open,
// the tile that just landed, and the small motion helpers (a tweened number, a
// list whose leavers collapse before they go). No components.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  PROVIDER_NAMES,
  isOn,
  serviceOf,
  type Account,
  type AccountState,
  type Consumer,
  type ProviderId,
  type Scope,
  type State,
} from "./store.prototype";

/* ── The page's own state ───────────────────────────────────────────── */

export type Sheet =
  /** Without a service, the sheet starts on the registry list. */
  | { kind: "connect"; serviceId?: string | undefined; moveFrom?: string | undefined }
  /** Adding a connector, over the directory page: a connector's summary, or a custom one. */
  | { kind: "summary"; serviceId: string; back?: boolean | undefined }
  | { kind: "custom" }
  | { kind: "vault" };

/** What a detail page is about: one of Crew's connectors, or one provider server. */
export type Detail = { kind: "connector"; serviceId: string } | { kind: "server"; key: string };

type Ui = {
  /** The page on screen: the connectors, the directory to add one from, or one connector's own page. */
  view: "home" | "directory" | "detail";
  detail: Detail | null;
  sheet: Sheet | null;
  /** Accounts a connect sheet is still making: the shelf shows them when it closes. */
  hidden: string[];
  /** The account whose tile just popped into the shelf. */
  landed: string | null;
  /** The sheet is playing its way out; it unmounts when that ends. */
  leaving: boolean;
};

const EMPTY: Ui = { view: "home", detail: null, sheet: null, hidden: [], landed: null, leaving: false };
let current: Ui = EMPTY;
const listeners = new Set<() => void>();
const put = (next: Partial<Ui>) => {
  current = { ...current, ...next };
  listeners.forEach((l) => l());
};

export function useUi(): Ui {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** How long a sheet takes to leave: its backdrop fades and the panel drops away. */
export const LEAVE_MS = 180;

let landTimer = 0;
let leaveTimer = 0;
/** Plays the sheet out, then unmounts it and runs `then`. */
function leave(then: Partial<Ui> = {}) {
  if (!current.sheet) return put(then);
  window.clearTimeout(leaveTimer);
  put({ leaving: true });
  leaveTimer = window.setTimeout(() => put({ sheet: null, leaving: false, ...then }), reduced() ? 0 : LEAVE_MS);
}

export const ui = {
  reset: () => put(EMPTY),
  open: (sheet: Sheet) => {
    window.clearTimeout(leaveTimer);
    put({ sheet, leaving: false });
  },
  close: () => leave(),
  /** Switch page; any sheet goes with it. */
  go: (view: Ui["view"]) => put({ view, sheet: null, leaving: false }),
  /** Open a connector's or a server's own page. */
  detail: (detail: Detail) => put({ view: "detail", detail, sheet: null, leaving: false }),
  hide: (id: string) => put({ hidden: [...current.hidden, id] }),
  /** The connect sheet closed: its account joins the shelf with a pop. */
  land(id: string | null) {
    // Back on the connectors, where the new tile lands.
    leave({ view: "home", hidden: current.hidden.filter((x) => x !== id), landed: id });
    window.clearTimeout(landTimer);
    landTimer = window.setTimeout(() => put({ landed: null }), 1900 + LEAVE_MS);
  },
};

/** A click on an installed connector, or on a provider server, opens its page. */
export const openConnector = (serviceId: string) => ui.detail({ kind: "connector", serviceId });
export const openServer = (key: string) => ui.detail({ kind: "server", key });

/* ── Reading the model the way this variant shows it ─────────────────── */

export const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export const ACCOUNT_TONE: Record<AccountState, Tone> = {
  connected: "success",
  expired: "warning",
  "needs-scope": "warning",
  "lease-ending": "warning",
  // Paused waits on the vault, not on you: it says so in words, without a dot.
  "vault-offline": "neutral",
};

export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-text-muted",
};
export const TONE_BG: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-text-muted",
};
export const TONE_SOFT: Record<Tone, string> = {
  success: "bg-success/12 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-danger/10 text-danger",
  info: "bg-info/12 text-info",
  neutral: "bg-fill text-text-muted",
};

export const sameScope = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind === "everywhere" || (b.kind !== "everywhere" && a.id === b.id));

export const scopeOf = (consumer: Consumer): Scope => ({ kind: consumer.kind, id: consumer.id });

/** Whether a consumer gets the account only because a wider scope says so. */
export function inherited(account: Account, consumer: Consumer): boolean {
  return !account.bindings.some((b) => sameScope(b.scope, scopeOf(consumer)));
}

/** Flip a consumer, leaving the fewest bindings: drop its own when the wider scope already says the same. */
export function flip(s: State, account: Account, consumer: Consumer): { scope: Scope; on: boolean | null } {
  const scope = scopeOf(consumer);
  const next = !isOn(s, account, consumer);
  const without = { ...account, bindings: account.bindings.filter((b) => !sameScope(b.scope, scope)) };
  return { scope, on: isOn(s, without, consumer) === next ? null : next };
}

/** One line for a service's tile: the account's identity, or how many there are. */
export function accountsLine(accounts: Account[]): string {
  const [only] = accounts;
  return accounts.length === 1 && only ? only.identity : `${accounts.length} accounts`;
}

/** Context a consumer's Claude Code session on this Mac starts with, split by where it comes from. */
export function contextSplit(s: State, account: Account, consumer: Consumer) {
  const own = s.servers
    .filter((x) => x.machine === "local" && x.provider === "claude" && !x.offInCrew && x.state === "connected")
    .reduce((n, x) => n + x.tokens, 0);
  const tokensOf = (a: Account) => serviceOf(a.serviceId)?.tools.filter((t) => !a.toolsOff.includes(t.name)).reduce((n, t) => n + t.tokens, 0) ?? 0;
  const others = s.accounts.filter((a) => a.id !== account.id && isOn(s, a, consumer)).reduce((n, a) => n + tokensOf(a), 0);
  const mine = isOn(s, account, consumer) ? tokensOf(account) : 0;
  return { own, others, mine, total: own + others + mine };
}

export function providersOf(servers: { provider: ProviderId }[]): string {
  const names = [...new Set(servers.map((x) => PROVIDER_NAMES[x.provider]))];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ── Motion helpers ─────────────────────────────────────────────────── */

/** A number that eases to its target, for meters and counts. */
export function useTween(target: number, ms = 520): number {
  const [value, setValue] = useState(target);
  const at = useRef(target);
  useEffect(() => {
    const from = at.current;
    if (from === target) return;
    const still = reduced();
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = still ? 1 : Math.min(1, (now - start) / ms);
      const next = from + (target - from) * (1 - Math.pow(1 - t, 3));
      at.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

/** Escape closes a sheet even when focus fell back to the page (a step's button unmounted under it). */
export function useEscape(close: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.closest("[role=dialog]")) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
}

/** A list whose removed items stay a moment, marked leaving, so they can collapse away. */
export function useExiting<T extends { id: string }>(items: T[], ms = 460): { item: T; leaving: boolean }[] {
  const key = items.map((i) => i.id).join("\u0000");
  const [seen, setSeen] = useState(() => ({ key, items, order: items.map((i) => i.id), gone: [] as T[] }));
  if (seen.key !== key) {
    const ids = new Set(items.map((i) => i.id));
    const gone = [...seen.gone.filter((g) => !ids.has(g.id)), ...seen.items.filter((i) => !ids.has(i.id))];
    const goneIds = new Set(gone.map((g) => g.id));
    const order = [...seen.order.filter((id) => ids.has(id) || goneIds.has(id)), ...items.map((i) => i.id).filter((id) => !seen.order.includes(id))];
    setSeen({ key, items, order, gone });
  }
  useEffect(() => {
    if (seen.gone.length === 0) return;
    const timer = window.setTimeout(
      () => setSeen((x) => ({ ...x, gone: [], order: x.order.filter((id) => x.items.some((i) => i.id === id)) })),
      ms,
    );
    return () => window.clearTimeout(timer);
  }, [seen.gone, ms]);
  const live = new Map(items.map((i) => [i.id, i]));
  return seen.order.flatMap((id): { item: T; leaving: boolean }[] => {
    const item = live.get(id);
    if (item) return [{ item, leaving: false }];
    const left = seen.gone.find((g) => g.id === id);
    return left ? [{ item: left, leaving: true }] : [];
  });
}

/** The variant's keyframes, beside the shared proto-* ones. */
export const KEYFRAMES = `
@keyframes c-orbit { to { transform: rotate(360deg); } }
@keyframes c-unorbit { to { transform: rotate(-360deg); } }
@keyframes c-in-next { from { opacity: 0; transform: translateX(22px); } }
@keyframes c-in-back { from { opacity: 0; transform: translateX(-22px); } }
@keyframes c-in-up { from { opacity: 0; transform: translateY(10px); } }
@keyframes c-pop { 0% { opacity: 0; transform: scale(0.55) translateY(10px); } 60% { opacity: 1; transform: scale(1.04); } 100% { transform: none; } }
@keyframes c-seed { 0% { opacity: 0; transform: scale(0.2); } 70% { opacity: 1; transform: scale(1.12); } 100% { opacity: 1; transform: none; } }
@keyframes c-burst { from { transform: scale(0.7); opacity: 0.6; } to { transform: scale(2.3); opacity: 0; } }
@keyframes c-spark { 0% { transform: rotate(var(--a)) translateY(0) scale(1); opacity: 1; } 100% { transform: rotate(var(--a)) translateY(-54px) scale(0.3); opacity: 0; } }
@keyframes c-glow { 0% { opacity: 1; } 100% { opacity: 0; } }
@keyframes c-breathe { 50% { transform: scale(1.08); opacity: 0.55; } }
@keyframes c-ping { 0% { transform: scale(1); opacity: 0.55; } 100% { transform: scale(2.6); opacity: 0; } }
@keyframes c-halo { 0% { transform: scale(1); opacity: 0.7; } 100% { transform: scale(1.45); opacity: 0; } }
@keyframes c-shimmer { from { transform: translateX(-100%); } to { transform: translateX(220%); } }
@keyframes c-cursor { 0% { transform: translate(70px, 46px); opacity: 0; } 15% { opacity: 1; } 55% { transform: translate(0, 0); } 64% { transform: translate(0, 0) scale(0.82); } 74%, 100% { transform: translate(0, 0) scale(1); opacity: 1; } }
@keyframes c-allow { 0%, 60% { filter: none; transform: none; } 66% { transform: scale(0.94); filter: brightness(1.25); } 80%, 100% { transform: none; filter: brightness(1.12); } }
@keyframes c-travel { from { offset-distance: 0%; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } to { offset-distance: 100%; opacity: 0; } }
@keyframes c-draw { from { stroke-dashoffset: var(--len); } }
@keyframes c-bob { 50% { transform: translateY(-3px); } }
@keyframes c-collapse { to { opacity: 0; transform: scale(0.92); } }
@keyframes c-ringin { from { transform: rotate(-140deg); opacity: 0; } }
@keyframes c-spin { to { transform: rotate(360deg); } }
@keyframes c-growx { from { transform: scaleX(0); } }
@keyframes c-hop { 0% { left: 0; opacity: 0; } 10% { opacity: 1; } 45% { left: calc(100% - 7px); opacity: 1; } 55%, 100% { left: calc(100% - 7px); opacity: 0; } }
@keyframes c-slide { from { left: 0; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } to { left: calc(100% - 16px); opacity: 0; } }
@keyframes c-sheet { from { opacity: 0; transform: translateY(14px) scale(0.98); } }
@keyframes c-sheet-out { to { opacity: 0; transform: translateY(8px) scale(0.985); } }
@keyframes c-fade { from { opacity: 0; } }
@keyframes c-fade-out { to { opacity: 0; } }
`;
