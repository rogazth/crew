// PROTOTYPE — throwaway. The providers' plan usage, as the rail's rings and
// Settings › Usage both read it: fake readings, the pace math, and which
// providers have a ring on the rail. Nothing is fetched.
import { useSyncExternalStore } from "react";

export type Window = {
  label: string;
  /** Share used, 0‥100. */
  used: number;
  /** The window's whole length and what is left of it, in minutes. */
  length: number;
  resetsIn: number;
};

export type Reading =
  | {
      provider: string;
      name: string;
      plan: string;
      account: string;
      windows: Window[];
      /** Share of the longest window spent each day, the last seven days, oldest first. */
      history: number[];
    }
  | { provider: string; name: string; plan: null; windows: [] };

/** How the rail shows it: one ring per provider, outermost first, like the Watch; or one ring with the tightest limit. */
export const INDICATOR: "rings" | "single" = "rings";

export const READINGS: Reading[] = [
  {
    provider: "claude",
    name: "Claude",
    plan: "Max 5×",
    account: "gabriel98rl@gmail.com",
    history: [9, 14, 4, 0, 11, 16, 7],
    windows: [
      { label: "Session", used: 78, length: 300, resetsIn: 110 },
      { label: "Weekly", used: 41, length: 7 * 1440, resetsIn: 3 * 1440 + 4 * 60 },
    ],
  },
  {
    provider: "codex",
    name: "Codex",
    plan: "Plus",
    account: "gabriel98rl@gmail.com",
    history: [6, 12, 19, 8, 0, 9, 12],
    windows: [
      { label: "Session", used: 18, length: 300, resetsIn: 252 },
      { label: "Weekly", used: 66, length: 7 * 1440, resetsIn: 1440 + 9 * 60 },
    ],
  },
  {
    provider: "cursor",
    name: "Cursor",
    plan: "Pro",
    account: "gabriel98rl@gmail.com",
    history: [2, 1, 3, 0, 0, 2, 1],
    windows: [{ label: "Monthly", used: 34, length: 30 * 1440, resetsIn: 19 * 1440 }],
  },
  { provider: "opencode", name: "OpenCode", plan: null, windows: [] },
];

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

/** At the pace so far in this window, how long until it is spent; null when it outlasts the reset. */
export function runsOutIn(window: Window): number | null {
  const elapsed = window.length - window.resetsIn;
  if (elapsed <= 0 || window.used <= 0) return null;
  const left = ((100 - window.used) * elapsed) / window.used;
  return left < window.resetsIn ? left : null;
}

/** The limit closest to running out, across every provider. */
export function tightest(): { reading: Reading; window: Window } | null {
  let best: { reading: Reading; window: Window } | null = null;
  for (const reading of READINGS)
    for (const window of reading.windows) if (!best || window.used > best.window.used) best = { reading, window };
  return best;
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

const RINGS_KEY = "crew.proto.usageRings.v2";
const ringWatchers = new Set<() => void>();
const PLANS = READINGS.filter((reading) => reading.plan).map((reading) => reading.provider);
const DEFAULT_COLORS: Record<string, RingColorId> = { claude: "clay", codex: "blue", cursor: "teal" };
let rings = readRings();

function readRings(): RingConfig {
  const fallback: RingConfig = { order: PLANS, shown: PLANS.slice(0, MAX_RINGS), colors: DEFAULT_COLORS };
  try {
    const saved = JSON.parse(localStorage.getItem(RINGS_KEY) ?? "null") as RingConfig | null;
    if (!saved) return fallback;
    // A provider that started reporting since goes last; one that stopped drops out.
    const order = [...saved.order.filter((id) => PLANS.includes(id)), ...PLANS.filter((id) => !saved.order.includes(id))];
    return { order, shown: saved.shown.filter((id) => PLANS.includes(id)), colors: { ...DEFAULT_COLORS, ...saved.colors } };
  } catch {
    return fallback;
  }
}

function setRings(next: RingConfig) {
  rings = next;
  try {
    localStorage.setItem(RINGS_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the rings still change for this window.
  }
  for (const watch of ringWatchers) watch();
}

/** The rings' setup, in the rail and in Settings alike. */
export function useRings(): RingConfig {
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

/** Every reading in the user's order; those without a plan reading last. */
export function inOrder(config: RingConfig): Reading[] {
  const rank = (reading: Reading) => (reading.plan ? config.order.indexOf(reading.provider) : Infinity);
  return [...READINGS].sort((a, b) => rank(a) - rank(b));
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
  setRings({ order: PLANS, shown: PLANS.slice(0, MAX_RINGS), colors: DEFAULT_COLORS });
}

/* ── Refresh ────────────────────────────────────────────────────────── */

type Freshness = { updatedAt: number; refreshing: boolean };
const freshWatchers = new Set<() => void>();
let freshness: Freshness = { updatedAt: Date.now() - 2 * 60_000, refreshing: false };

function setFreshness(next: Freshness) {
  freshness = next;
  for (const watch of freshWatchers) watch();
}

/** When the readings were last taken, and whether a refresh is under way; the rail and Settings share it. */
export function useFreshness(): Freshness {
  return useSyncExternalStore(
    (watch) => {
      freshWatchers.add(watch);
      return () => freshWatchers.delete(watch);
    },
    () => freshness,
  );
}

/** Asks every CLI again. Simulated: a short wait, then the same readings, fresh. */
export function refreshUsage(): Promise<void> {
  if (freshness.refreshing) return Promise.resolve();
  setFreshness({ ...freshness, refreshing: true });
  return new Promise((resolve) =>
    window.setTimeout(() => {
      setFreshness({ updatedAt: Date.now(), refreshing: false });
      resolve();
    }, 900),
  );
}

export function updatedLabel(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  return minutes < 1 ? "Updated just now" : `Updated ${span(minutes)} ago`;
}
