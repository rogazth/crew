// The Connectors page's own state and helpers: which page and sheet are on
// screen, the connector that just landed, the tones the states read in, and
// the small motion helpers. No components.
import { useEffect, useSyncExternalStore } from "react";
import type { RegistryServer } from "../../../lib/protocol";
import { protoName, type ServiceId } from "./prototype-google";
import { connectorOf, isOn, sameScope, useIntegrations, type Account, type AccountState, type Consumer, type Scope, type Source } from "./store";

/* ── The page's own state ───────────────────────────────────────────── */

export type Sheet =
  /** Installing a connector and signing in to it. */
  | { kind: "connect"; source: Source }
  /** A registry server before it is installed, over the directory. */
  | { kind: "summary"; server: RegistryServer; back?: boolean | undefined }
  | { kind: "custom" }
  /** PROTOTYPE: installing a Google app (prototype-google.tsx). */
  | { kind: "proto"; id: ServiceId }
  /** PROTOTYPE: a Google app's summary, from its row in Browse (prototype-google.tsx). */
  | { kind: "proto-summary"; id: ServiceId }
  /** What a built-in connector is, from its summary or page (builtin.tsx). */
  | { kind: "built-in" };

/** What a detail page is about: one of Crew's connectors, or one provider server on one machine (by its name). */
export type Detail =
  | { kind: "connector"; id: string }
  | { kind: "server"; envId: string; key: string; name: string }
  /** PROTOTYPE: a Google app's page (prototype-google.tsx). */
  | { kind: "proto"; id: ServiceId };

type Ui = {
  /** The page on screen: the connectors, the directory to add one from, or one connector's or server's own page. */
  view: "home" | "directory" | "detail";
  /** What the detail page is about. */
  detail: Detail | null;
  sheet: Sheet | null;
  /** Connectors a connect sheet is still making: the shelf shows them when it closes. */
  hidden: string[];
  /** The connector whose tile just popped into the shelf. */
  landed: string | null;
  /** The sheet is playing its way out; it unmounts when that ends. */
  leaving: boolean;
  /** The sheet replaced another one: the backdrop is already up, so only the panel changes. */
  swapped: boolean;
};

const EMPTY: Ui = { view: "home", detail: null, sheet: null, hidden: [], landed: null, leaving: false, swapped: false };
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
export const LEAVE_MS = 140;

let landTimer = 0;
let leaveTimer = 0;
/** Plays the sheet out, then unmounts it and applies `then`. */
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
    put({ sheet, leaving: false, swapped: current.sheet !== null });
  },
  close: () => leave(),
  /** Switch page; any sheet goes with it. */
  go: (view: Ui["view"]) => put({ view, sheet: null, leaving: false }),
  /** Open a connector's or a server's own page. */
  detail: (detail: Detail) => put({ view: "detail", detail, sheet: null, leaving: false }),
  hide: (id: string) => put({ hidden: [...current.hidden, id] }),
  /** The connect sheet closed on a failure: nothing lands, and the page stays as it was. */
  drop: (id: string) => leave({ hidden: current.hidden.filter((x) => x !== id) }),
  /** The connect sheet closed: its connector joins the shelf with a pop. */
  land(id: string | null) {
    // Back on the connectors, where the new tile lands.
    leave({ view: "home", hidden: current.hidden.filter((x) => x !== id), landed: id });
    window.clearTimeout(landTimer);
    landTimer = window.setTimeout(() => put({ landed: null }), 1900 + LEAVE_MS);
  },
};

/** The page strip's trail: empty on the connectors (the page heads itself), Connectors › Browse on the directory. */
export function useIntegrationsTrail(): (string | { label: string; onClick: () => void })[] {
  const s = useIntegrations();
  const { view, detail } = useUi();
  const back = { label: "Connectors", onClick: () => ui.go("home") };
  if (view === "detail" && detail) return [back, detail.kind === "connector" ? (connectorOf(s, detail.id)?.name ?? "Connector") : detail.kind === "proto" ? protoName(detail.id) : detail.name];
  return view === "directory" ? [back, "Browse"] : [];
}

/** A click on an installed connector, or on a provider server, opens its page. */
export const openConnector = (connectorId: string) => ui.detail({ kind: "connector", id: connectorId });
export const openServer = (envId: string, key: string, name: string) => ui.detail({ kind: "server", envId, key, name });

/* ── Reading the model the way the page shows it ─────────────────────── */

export const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export const ACCOUNT_TONE: Record<AccountState, Tone> = {
  connected: "success",
  expired: "warning",
  "needs-scope": "warning",
  failed: "warning",
  // A sign-in that never finished waits on the person, but nothing is broken.
  pending: "neutral",
};

/** What's off, in a word; all well says nothing but who it is. */
export const ACCOUNT_PROBLEM: Partial<Record<AccountState, string>> = {
  expired: "Needs authentication",
  "needs-scope": "Missing permissions",
  failed: "Can’t connect",
  pending: "Not signed in",
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

export const scopeOf = (consumer: Consumer): Scope => ({ kind: consumer.kind, id: consumer.id });

/** Whether a consumer gets the account only because a wider scope says so. */
export function inherited(account: Account, consumer: Consumer): boolean {
  return !account.bindings.some((b) => sameScope(b.scope, scopeOf(consumer)));
}

/** Flip a consumer, leaving the fewest bindings: drop its own when the wider scope already says the same. */
export function flip(account: Account, consumer: Consumer): { scope: Scope; on: boolean | null } {
  const scope = scopeOf(consumer);
  const next = !isOn(account, consumer);
  const without = { ...account, bindings: account.bindings.filter((b) => !sameScope(b.scope, scope)) };
  return { scope, on: isOn(without, consumer) === next ? null : next };
}

/** One line for a connector's tile: the account's identity, or how many there are. */
export function accountsLine(accounts: Account[]): string {
  const [only] = accounts;
  if (accounts.length === 0) return "No accounts";
  return accounts.length === 1 && only ? (only.identity ?? only.label) : `${accounts.length} accounts`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/* ── Motion helpers ─────────────────────────────────────────────────── */

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

/** The page's keyframes. */
export const KEYFRAMES = `
@keyframes c-orbit { to { transform: rotate(360deg); } }
@keyframes c-unorbit { to { transform: rotate(-360deg); } }
@keyframes c-glow { 0% { opacity: 1; } 100% { opacity: 0; } }
@keyframes c-ping { 0% { transform: scale(1); opacity: 0.55; } 100% { transform: scale(2.6); opacity: 0; } }
`;
