// Plan usage as the app reads it: what each machine's crewd reports, mapped to
// what the rail and Settings draw, and one reading per account however many
// machines read it. Pure, so the store in usage.ts stays thin.
import type { PlanUsage, UsageSnapshot, UsageTokens, UsageWindow } from "./protocol";

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

export type TokenKind = "input" | "output" | "cacheWrite" | "cacheRead";
export type TokenCounts = Record<TokenKind, number>;
export type ModelTokens = TokenCounts & { model: string };
export type TokenDay = { day: string; models: ModelTokens[] };

export type Reading = {
  provider: string;
  name: string;
  plan: string | null;
  account: string | null;
  windows: Window[];
  /** Tokens and cost over the last week, for a provider with no plan windows. */
  tokens: number | null;
  /** What the provider spent day by day and model by model, oldest first, today last; on one account of each provider, and none with nothing spent. */
  tokenDays: TokenDay[] | null;
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

/** How many days of usage are kept and drawn. */
export const HISTORY_DAYS = 30;

/** The top of a chart's axis: a round number a little above the peak, so the busiest day never reads as a ceiling. */
export function axisTop(peak: number): number {
  const wanted = Math.max(peak * 1.1, 1_000_000);
  const power = 10 ** Math.floor(Math.log10(wanted));
  return ([1, 1.5, 2, 3, 5, 7.5, 10].find((step) => step * power >= wanted) ?? 10) * power;
}

const NO_TOKENS: TokenCounts = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function wholeTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead;
}

/** What several rows add up to. */
export function tokensOf(rows: TokenCounts[]): TokenCounts {
  return rows.reduce<TokenCounts>(
    (sum, row) => ({
      input: sum.input + row.input,
      output: sum.output + row.output,
      cacheWrite: sum.cacheWrite + row.cacheWrite,
      cacheRead: sum.cacheRead + row.cacheRead,
    }),
    NO_TOKENS,
  );
}

/** A part this small a share of its day is left to the tooltip; any larger gets at least `MIN_PART` pixels. */
const MIN_SHARE = 0.001;
const MIN_PART = 2;

/** Each part's height in a day's bar, bottom first. The bar keeps its true height: what a small part is lifted by comes out of the largest. */
export function stackHeights(tokens: TokenCounts, top: number, height: number, order: TokenKind[]): { key: TokenKind; height: number }[] {
  const whole = wholeTokens(tokens);
  if (whole === 0) return [];
  const parts = order
    .filter((key) => tokens[key] / whole >= MIN_SHARE)
    .map((key) => ({ key, height: Math.max(MIN_PART, (tokens[key] / top) * height) }));
  const largest = parts.reduce((best, part) => (tokens[part.key] > tokens[best.key] ? part : best));
  const others = parts.reduce((sum, part) => (part === largest ? sum : sum + part.height + 1), 0);
  largest.height = Math.max(1, (whole / top) * height - others);
  return parts;
}

/** The machine's calendar day, as each daemon counts its tokens. */
function localDay(ms: number): string {
  const at = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The days ending today, oldest first, with the models that spent on each; none when nothing was spent. */
export function tokenDays(rows: UsageTokens[], now: number): TokenDay[] | null {
  const days = Array.from({ length: HISTORY_DAYS }, (_, index): TokenDay => ({ day: localDay(now - (HISTORY_DAYS - 1 - index) * DAY), models: [] }));
  const byDay = new Map(days.map((day) => [day.day, day]));
  for (const { day, model, input, output, cacheWrite, cacheRead } of rows) {
    byDay.get(day)?.models.push({ model, input, output, cacheWrite, cacheRead });
  }
  return days.some((day) => day.models.length > 0) ? days : null;
}

/** Cursor's tokens are its account's, read whole by every machine; the rest are each machine's own logs, so they add up. */
const ACCOUNT_WIDE = new Set(["cursor"]);

/** Every machine's tokens, per provider, one row per day and model. */
function mergeTokens(snapshots: UsageSnapshot[]): Map<string, UsageTokens[]> {
  const merged = new Map<string, UsageTokens>();
  for (const snapshot of snapshots) {
    // A machine on an older build says none.
    for (const row of snapshot.tokens ?? []) {
      const key = `${row.provider}|${row.day}|${row.model}`;
      const held = merged.get(key);
      if (!held) merged.set(key, row);
      else if (ACCOUNT_WIDE.has(row.provider)) {
        if (wholeTokens(row) > wholeTokens(held)) merged.set(key, row);
      } else merged.set(key, { ...held, ...tokensOf([held, row]) });
    }
  }
  const providers = new Map<string, UsageTokens[]>();
  for (const row of merged.values()) providers.set(row.provider, [...(providers.get(row.provider) ?? []), row]);
  return providers;
}

/** One account, wherever it is read. */
export function accountKey(item: { provider: string; account?: string | null }): string {
  return `${item.provider}|${item.account ?? ""}`;
}

/**
 * Every machine's snapshot folded into one reading per provider and account:
 * the latest `updatedAt` wins. Tokens are a provider's, not an account's, so they
 * go on its reading read last. The most recently read come first.
 */
export function mergeSnapshots(snapshots: Iterable<UsageSnapshot>, now: number): Reading[] {
  const all = [...snapshots];
  const latest = new Map<string, PlanUsage>();
  for (const snapshot of all) {
    for (const reading of snapshot.readings) {
      const key = accountKey(reading);
      const seen = latest.get(key);
      if (!seen || reading.updatedAt > seen.updatedAt) latest.set(key, reading);
    }
  }
  const spent = mergeTokens(all);
  const readings = [...latest.values()]
    .map((reading): Reading => {
      const windows = reading.windows.map((window) => windowOf(window, now));
      return {
        provider: reading.provider,
        name: providerName(reading.provider),
        plan: reading.plan ?? null,
        account: reading.account ?? null,
        windows,
        tokens: reading.tokens ?? null,
        tokenDays: null,
        cost: reading.cost ?? null,
        status: reading.status ?? null,
        updatedAt: reading.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return readings.map((reading) =>
    ofProvider(readings, reading.provider) === reading ? { ...reading, tokenDays: tokenDays(spent.get(reading.provider) ?? [], now) } : reading,
  );
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

export type Pace = {
  /** Where the share used would stand had the window been spent evenly so far, 0‥100. */
  expected: number;
  /** Points left in hand: under that even line (positive) or over it (negative). */
  reserve: number;
  /** Minutes until it is spent at this pace; null when it lasts until the reset. */
  runsOutIn: number | null;
};

/** How the window is being spent against an even pace; null when its length or reset is unknown. */
export function paceOf(window: Window): Pace | null {
  if (window.length === null || window.resetsIn === null || window.length <= 0) return null;
  const elapsed = Math.min(window.length, Math.max(0, window.length - window.resetsIn));
  const expected = (elapsed / window.length) * 100;
  return { expected, reserve: expected - window.used, runsOutIn: runsOutIn(window) };
}
