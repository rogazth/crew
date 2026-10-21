// Plan usage as the app reads it: what each machine's crewd reports, mapped to
// what the rail and Settings draw, and one reading per account however many
// machines read it. Pure, so the store in usage.ts stays thin.
import type { PlanUsage, UsageDay, UsageSnapshot, UsageWindow } from "./protocol";

const MINUTE = 60_000;
const DAY = 86_400_000;

export type Window = {
  id: string;
  label: string;
  /** Share used, 0‥100. */
  used: number;
  /** The window's whole length and what is left of it, in minutes; null when the provider does not say. */
  length: number | null;
  resetsIn: number | null;
};

export type UsageDayPoint = { day: string; percent: number };

export type Reading = {
  provider: string;
  name: string;
  plan: string | null;
  account: string | null;
  windows: Window[];
  /** Share of the longest window spent each day, the last seven days (UTC), oldest first. */
  history: UsageDayPoint[];
  /** Tokens and cost over the last week, for a provider with no plan windows. */
  tokens: number | null;
  cost: number | null;
  /** Claude's own verdict on the plan limit. */
  status: string | null;
  updatedAt: number;
};

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", grok: "Grok" };

export function providerName(provider: string): string {
  return NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function windowOf(window: UsageWindow, now: number): Window {
  return {
    id: window.id,
    label: window.label,
    used: Math.min(100, Math.max(0, Math.round(window.usedPercent))),
    length: window.windowMinutes ?? null,
    resetsIn: window.resetsAt == null ? null : Math.max(0, (window.resetsAt - now) / MINUTE),
  };
}

/** The UTC day, as the daemon keeps its history. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Seven days ending today, oldest first, each the highest share any machine saw that day. */
export function weekOf(days: UsageDay[], now: number): UsageDayPoint[] {
  const high = new Map<string, number>();
  for (const { day, percent } of days) high.set(day, Math.max(high.get(day) ?? 0, percent));
  return Array.from({ length: 7 }, (_, index) => {
    const day = dayKey(now - (6 - index) * DAY);
    return { day, percent: Math.round(high.get(day) ?? 0) };
  });
}

/** One account, wherever it is read. */
export function accountKey(item: { provider: string; account?: string | null }): string {
  return `${item.provider}|${item.account ?? ""}`;
}

/**
 * Every machine's snapshot folded into one reading per provider and account:
 * the latest `updatedAt` wins, the history keeps each day's highest. The most
 * recently read come first.
 */
export function mergeSnapshots(snapshots: Iterable<UsageSnapshot>, now: number): Reading[] {
  const latest = new Map<string, PlanUsage>();
  const days = new Map<string, UsageDay[]>();
  for (const snapshot of snapshots) {
    for (const reading of snapshot.readings) {
      const key = accountKey(reading);
      const seen = latest.get(key);
      if (!seen || reading.updatedAt > seen.updatedAt) latest.set(key, reading);
    }
    for (const day of snapshot.history) {
      const key = accountKey(day);
      days.set(key, [...(days.get(key) ?? []), day]);
    }
  }
  return [...latest.entries()]
    .map(([key, reading]): Reading => {
      const windows = reading.windows.map((window) => windowOf(window, now));
      return {
        provider: reading.provider,
        name: providerName(reading.provider),
        plan: reading.plan ?? null,
        account: reading.account ?? null,
        windows,
        history: weekOf(days.get(key) ?? [], now),
        tokens: reading.tokens ?? null,
        cost: reading.cost ?? null,
        status: reading.status ?? null,
        updatedAt: reading.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A reading with limits to draw: it gets a ring and bars. */
export function hasWindows(reading: Reading): boolean {
  return reading.windows.length > 0;
}

/** The share used of the tightest window; 0 without one. */
export function peak(reading: Reading): number {
  return Math.max(0, ...reading.windows.map((window) => window.used));
}

/** The reading to show for a provider when it has several accounts: the one read last. */
export function ofProvider(readings: Reading[], provider: string): Reading | undefined {
  return readings.find((reading) => reading.provider === provider);
}

export type Crossing = { reading: Reading; window: Window };

/** What the alerts have seen of each window: the ones past the threshold, and the ones seen under it. */
export type Look = { over: Set<string>; below: Set<string> };

/**
 * The windows that went past `at` since the last look. A window alerts only
 * when it was seen under `at` before and is past it now, so one that is
 * already high when it first appears (a machine that has just come online,
 * the first look at all) is learned, not announced. Windows missing from this
 * look (a machine that is away) keep what was known of them.
 */
export function crossings(
  readings: Reading[],
  look: Look | null,
  at: number,
): { fresh: Crossing[]; look: Look } {
  const over = new Set(look?.over);
  const below = new Set(look?.below);
  const fresh: Crossing[] = [];
  for (const reading of readings)
    for (const window of reading.windows) {
      const key = `${accountKey(reading)}|${window.id}`;
      if (window.used < at) {
        over.delete(key);
        below.add(key);
        continue;
      }
      if (look && !look.over.has(key) && look.below.has(key)) fresh.push({ reading, window });
      over.add(key);
      below.delete(key);
    }
  return { fresh, look: { over, below } };
}

/** At the pace so far in this window, how long until it is spent; null when it outlasts the reset or the pace is unknown. */
export function runsOutIn(window: Window): number | null {
  if (window.length === null || window.resetsIn === null) return null;
  const elapsed = window.length - window.resetsIn;
  if (elapsed <= 0 || window.used <= 0) return null;
  const left = ((100 - window.used) * elapsed) / window.used;
  return left < window.resetsIn ? left : null;
}
