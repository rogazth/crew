import type { HistoryEntry } from "../protocol";
import { dayName } from "../time";

export type HistoryDay = { key: string; label: string; entries: HistoryEntry[] };

/** Rows arrive newest first; each local calendar day becomes one group, in the same order. */
export function groupByDay(entries: readonly HistoryEntry[], now = Date.now()): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const entry of entries) {
    const at = new Date(entry.lastVisitedAt);
    const key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else days.push({ key, label: dayName(entry.lastVisitedAt, now), entries: [entry] });
  }
  return days;
}

export type ClearRange = "hour" | "today" | "all";

export const CLEAR_RANGES: { id: ClearRange; label: string }[] = [
  { id: "hour", label: "Last hour" },
  { id: "today", label: "Today" },
  { id: "all", label: "All time" },
];

/** Where a clear starts; undefined clears everything. "Today" is the local day, not the last 24 hours. */
export function clearSince(range: ClearRange, now = Date.now()): number | undefined {
  if (range === "all") return undefined;
  if (range === "hour") return now - 3_600_000;
  const day = new Date(now);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/** What a row shows under its title: the host, without the `www.` nobody reads. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
