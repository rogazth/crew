// The providers' plan usage, as the rail's rings and Settings › Usage both read
// it: one store fed by every connected machine's crewd (a slice per machine,
// replaced whole on `usage-changed`, deduped by account), the pace math, which
// providers have a ring on the rail, and the alerts.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as api from "./api";
import { getLinks, subscribeLinks } from "./client/registry";
import { notify } from "./host";
import type { UsageSnapshot } from "./protocol";
import { crossings, hasWindows, mergeSnapshots, peak, type Crossing, type Look, type Reading, type Window } from "./usageData";

export { paceOf, runsOutIn } from "./usageData";
export type { Pace, Reading, Window } from "./usageData";

/** How the rail shows it: one ring per provider, outermost first, like the Watch; or one ring with the tightest limit. */
export const INDICATOR: "rings" | "single" = "rings";

/* ── The store ──────────────────────────────────────────────────────── */

const slices = new Map<string, UsageSnapshot>();
const watchers = new Set<() => void>();
let readings: Reading[] = [];
let fresh: Freshness = { updatedAt: null, refreshing: false };
let looked: Look | null = null;

function publish() {
  readings = mergeSnapshots(slices.values(), Date.now());
  fresh = { ...fresh, updatedAt: readings.length ? Math.max(...readings.map((reading) => reading.updatedAt)) : null };
  alertOn(readings);
  for (const watch of watchers) watch();
}

function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => watchers.delete(watch);
}

/** Replaces one machine's slice; `null` drops it. */
export function setSlice(envId: string, snapshot: UsageSnapshot | null) {
  if (snapshot) slices.set(envId, snapshot);
  else if (!slices.delete(envId)) return;
  publish();
}

/** One reading per provider and account, the most recently read first. */
export function useReadings(): Reading[] {
  return useSyncExternalStore(subscribe, () => readings);
}

export function currentReadings(): Reading[] {
  return readings;
}

/** The limit closest to running out, across every provider. */
export function tightest(list: Reading[] = readings): { reading: Reading; window: Window } | null {
  let best: { reading: Reading; window: Window } | null = null;
  for (const reading of list)
    for (const window of reading.windows) if (!best || window.used > best.window.used) best = { reading, window };
  return best;
}

export function tone(used: number) {
  return used >= 90 ? "danger" : used >= 75 ? "warning" : "neutral";
}

export const STROKE = { danger: "stroke-danger", warning: "stroke-warning", neutral: "stroke-icon" } as const;
export const BAR = { danger: "bg-danger", warning: "bg-warning", neutral: "bg-text-muted" } as const;
export const TEXT = { danger: "text-danger", warning: "text-warning", neutral: "text-text-muted" } as const;

export function span(minutes: number): string {
  if (minutes >= 1440) {
    const d = Math.floor(minutes / 1440);
    const h = Math.round((minutes % 1440) / 60);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.max(1, Math.round(minutes))}m`;
}

export function clock(minutesFromNow: number): string {
  const at = new Date(Date.now() + minutesFromNow * 60_000);
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The rail fits three rings at most. */
export const MAX_RINGS = 3;

/** Colours a ring can take, each a light and a dark step. The first three are the defaults. */
export const RING_COLORS = [
  { id: "clay", label: "Clay", value: "light-dark(#D97757, #D06E4E)" },
  { id: "blue", label: "Blue", value: "light-dark(#3B82F6, #5B8FF0)" },
  { id: "teal", label: "Teal", value: "light-dark(#0D9488, #14A89A)" },
  { id: "violet", label: "Violet", value: "light-dark(#8B5CF6, #9D7BF7)" },
  { id: "pink", label: "Pink", value: "light-dark(#DB2777, #E0508F)" },
  { id: "amber", label: "Amber", value: "light-dark(#B7791F, #D69E2E)" },
  { id: "green", label: "Green", value: "light-dark(#2F9E44, #40B356)" },
  { id: "slate", label: "Slate", value: "light-dark(#64748B, #94A3B8)" },
] as const;

export type RingColorId = (typeof RING_COLORS)[number]["id"];

/** Which providers have a ring, in what order (outermost first), and in what colour: a preset's id, or a custom `#rrggbb`. */
export type RingConfig = { order: string[]; shown: string[]; colors: Record<string, RingColorId | string> };

const RINGS_KEY = "usage:rings";
/** Where the redesign's dev build kept the setup, in this browser, before it lived in the store. */
const LEGACY_RINGS_KEY = "crew.proto.usageRings.v2";
const ringWatchers = new Set<() => void>();
/** The providers that report a plan, in the order a fresh setup shows them. */
const PLANS = ["claude", "codex", "cursor", "grok"];
const DEFAULT_COLORS: Record<string, RingColorId> = { claude: "clay", codex: "blue", cursor: "teal", grok: "violet" };
const FALLBACK: RingConfig = { order: PLANS, shown: PLANS.slice(0, MAX_RINGS), colors: DEFAULT_COLORS };
let rings: RingConfig = FALLBACK;
let ringsLoaded = false;

function parseRings(raw: string | null): RingConfig | null {
  try {
    const saved = JSON.parse(raw ?? "null") as RingConfig | null;
    if (!saved) return null;
    // A provider that started reporting since goes last; one that stopped drops out.
    const order = [...saved.order.filter((id) => PLANS.includes(id)), ...PLANS.filter((id) => !saved.order.includes(id))];
    return { order, shown: saved.shown.filter((id) => PLANS.includes(id)), colors: { ...DEFAULT_COLORS, ...saved.colors } };
  } catch {
    return null;
  }
}

function legacyRings(): string | null {
  try {
    return localStorage.getItem(LEGACY_RINGS_KEY);
  } catch {
    return null;
  }
}

/** Reads the setup from the store once; the old localStorage copy moves in and is deleted. */
function loadRings() {
  if (ringsLoaded) return;
  ringsLoaded = true;
  api
    .stateGet(RINGS_KEY)
    .then(async (raw) => {
      const saved = parseRings(raw);
      const old = saved ? null : parseRings(legacyRings());
      if (old) {
        await api.stateSet(RINGS_KEY, JSON.stringify(old));
        try {
          localStorage.removeItem(LEGACY_RINGS_KEY);
        } catch {
          // Left behind, it reads the same again.
        }
      }
      const next = saved ?? old;
      if (next) setRings(next, false);
    })
    .catch(() => {
      ringsLoaded = false;
    });
}

function setRings(next: RingConfig, save = true) {
  rings = next;
  if (save) void api.stateSet(RINGS_KEY, JSON.stringify(next)).catch(() => {});
  for (const watch of ringWatchers) watch();
}

/** The rings' setup, in the rail and in Settings alike. */
export function useRings(): RingConfig {
  useEffect(loadRings, []);
  return useSyncExternalStore(
    (watch) => {
      ringWatchers.add(watch);
      return () => ringWatchers.delete(watch);
    },
    () => rings,
  );
}

/** The providers with a ring, outermost first. */
export function shownInOrder(config: RingConfig): string[] {
  return config.order.filter((id) => config.shown.includes(id)).slice(0, MAX_RINGS);
}

/** Every reading in the user's order; those without limits last. */
export function inOrder(config: RingConfig, list: Reading[]): Reading[] {
  const rank = (reading: Reading) => (hasWindows(reading) ? config.order.indexOf(reading.provider) : Infinity);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** A provider's colour, wherever it is drawn: its ring, its bars, its dot. */
export function colorOf(config: RingConfig, provider: string): string {
  const id = config.colors[provider];
  if (id?.startsWith("#")) return id;
  return RING_COLORS.find((color) => color.id === id)?.value ?? RING_COLORS[RING_COLORS.length - 1]!.value;
}

/** Whether a ring can go on or off: one has to stay, and the rail fits no more than MAX_RINGS. */
export function canToggleRing(provider: string): boolean {
  return rings.shown.includes(provider) ? rings.shown.length > 1 : rings.shown.length < MAX_RINGS;
}

export function toggleRing(provider: string) {
  if (!canToggleRing(provider)) return;
  const shown = rings.shown.includes(provider) ? rings.shown.filter((id) => id !== provider) : [...rings.shown, provider];
  setRings({ ...rings, shown });
}

export function reorderRings(order: string[]) {
  setRings({ ...rings, order });
}

/** A colour another provider wears is not offered, so two rings never look alike. */
export function setRingColor(provider: string, color: RingColorId | string) {
  setRings({ ...rings, colors: { ...rings.colors, [provider]: color } });
}

export function resetRings() {
  setRings(FALLBACK);
}

/* ── Refresh ────────────────────────────────────────────────────────── */

type Freshness = { updatedAt: number | null; refreshing: boolean };

/** When the newest reading was taken, and whether a refresh is under way; the rail and Settings share it. */
export function useFreshness(): Freshness {
  return useSyncExternalStore(subscribe, () => fresh);
}

function onlineEnvs(): string[] {
  return getLinks()
    .filter((link) => link.status === "online")
    .map((link) => link.id);
}

// Refreshes under way; "Refreshing…" ends with the last of them, not the first.
let asking = 0;

/** Reads every connected machine, or only `only`; with `ask`, each crewd asks its CLIs again first. */
export async function refreshUsage(ask = true, only?: string[]): Promise<void> {
  if (ask) {
    asking += 1;
    fresh = { ...fresh, refreshing: true };
    for (const watch of watchers) watch();
  }
  const envs = onlineEnvs().filter((id) => !only || only.includes(id));
  try {
    await Promise.allSettled(
      envs.map((id) =>
        api
          .usageRead(ask, id)
          .then((snapshot) => setSlice(id, snapshot))
          .catch(() => {}),
      ),
    );
  } finally {
    if (ask) {
      asking -= 1;
      if (asking === 0) {
        fresh = { ...fresh, refreshing: false };
        for (const watch of watchers) watch();
      }
    }
  }
}

/** Re-renders its component every `ms`, so "n minutes ago" keeps counting. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function updatedLabel(at: number | null, now = Date.now()): string {
  if (at === null) return "Not read yet";
  const minutes = Math.floor((now - at) / 60_000);
  return minutes < 1 ? "Updated just now" : `Updated ${span(minutes)} ago`;
}

/** Keeps the store fed while mounted (once, in the rail): reads on start, on a machine coming online, on the interval, and on each push. */
export function useUsageSync() {
  const alerts = useAlerts();
  useEffect(() => api.onUsageChanged((snapshot, envId) => setSlice(envId, snapshot)), []);
  // A machine that comes online is read; one that left the list is dropped.
  const online = useSyncExternalStore(subscribeLinks, () => onlineEnvs().join("|"));
  const read = useRef<Set<string> | null>(null);
  useEffect(() => {
    const known = new Set(getLinks().map((link) => link.id));
    for (const id of [...slices.keys()]) if (!known.has(id)) setSlice(id, null);
    // Only a machine not read yet is asked; the others keep their reading until the interval.
    const now = onlineEnvs();
    const added = read.current ? now.filter((id) => !read.current!.has(id)) : now;
    read.current = new Set(now);
    if (added.length === 0) return;
    void refreshUsage(false, added).then(() => refreshUsage(true, added));
  }, [online]);
  // Resets count down between reads.
  useEffect(() => {
    const id = setInterval(publish, 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => void refreshUsage(true), alerts.every * 60_000);
    return () => clearInterval(id);
  }, [alerts.every]);
}

/* ── Alerts ─────────────────────────────────────────────────────────── */

/** Where in a window the notification fires, and where the composer starts to warn. */
export const NOTIFY_AT = 90;
export const WARN_AT = 85;

export type Alerts = { notify: boolean; composer: boolean; /** Minutes between refreshes. */ every: 1 | 5 | 15 };

const ALERTS_KEY = "usage:alerts";
const ALERT_DEFAULTS: Alerts = { notify: true, composer: true, every: 5 };
const alertWatchers = new Set<() => void>();
let alerts: Alerts = ALERT_DEFAULTS;
let alertsLoaded = false;

export function parseAlerts(raw: string | null): Alerts | null {
  try {
    const saved = JSON.parse(raw ?? "null") as Partial<Alerts> | null;
    if (!saved || typeof saved !== "object") return null;
    return {
      notify: typeof saved.notify === "boolean" ? saved.notify : ALERT_DEFAULTS.notify,
      composer: typeof saved.composer === "boolean" ? saved.composer : ALERT_DEFAULTS.composer,
      every: saved.every === 1 || saved.every === 5 || saved.every === 15 ? saved.every : ALERT_DEFAULTS.every,
    };
  } catch {
    return null;
  }
}

function loadAlerts() {
  if (alertsLoaded) return;
  alertsLoaded = true;
  api
    .stateGet(ALERTS_KEY)
    .then((raw) => {
      const saved = parseAlerts(raw);
      if (saved) {
        alerts = saved;
        for (const watch of alertWatchers) watch();
      }
    })
    .catch(() => {
      alertsLoaded = false;
    });
}

export function setAlerts(patch: Partial<Alerts>) {
  alerts = { ...alerts, ...patch };
  void api.stateSet(ALERTS_KEY, JSON.stringify(alerts)).catch(() => {});
  for (const watch of alertWatchers) watch();
}

/** The alert settings, persisted in the store, in Settings and wherever they apply. */
export function useAlerts(): Alerts {
  useEffect(loadAlerts, []);
  return useSyncExternalStore(
    (watch) => {
      alertWatchers.add(watch);
      return () => alertWatchers.delete(watch);
    },
    () => alerts,
  );
}

function describe({ reading, window }: Crossing): { title: string; body: string } {
  return {
    title: `${reading.name} usage at ${window.used}%`,
    body: `${window.label} limit${reading.account ? ` for ${reading.account}` : ""}.`,
  };
}

/** Tells once, through the notifications host, when a window passes the threshold. */
function alertOn(list: Reading[]) {
  // Until something has been read there is nothing to compare with.
  if (looked === null && list.length === 0) return;
  const result = crossings(list, looked, NOTIFY_AT);
  const first = looked === null;
  looked = result.look;
  if (first || !alerts.notify) return;
  for (const crossing of result.fresh) void notify({ ...describe(crossing), target: null }).catch(() => {});
}

/** The reading to warn about in a composer on this provider: its tightest window past the threshold, when warnings are on. */
export function warningFor(list: Reading[], provider: string, on: boolean): { reading: Reading; window: Window } | null {
  if (!on) return null;
  const top = tightest(list.filter((reading) => reading.provider === provider));
  return top && top.window.used >= WARN_AT ? top : null;
}

export { peak };
