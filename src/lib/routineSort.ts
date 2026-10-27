// How the routines' table sorts: one column at a time, a press per step.
import type { RoutineEntry } from "../hooks/useRoutines";
import { describeSchedule, parseSchedule } from "./routines";

export type SortKey = "name" | "schedule" | "last" | "next";
export type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

// Ascending is the way each column reads first: A to Z, the latest run first,
// the soonest run first. What has no time sinks to the end either way.
const SORTS: Record<SortKey, (entry: RoutineEntry) => string | number | null> = {
  name: ({ routine }) => (routine.name || "Untitled routine").toLowerCase(),
  schedule: ({ routine }) => describeSchedule(parseSchedule(routine.schedule)).toLowerCase(),
  last: ({ routine }) => (routine.runs[0] ? -routine.runs[0].startedAt : null),
  next: ({ routine }) => (routine.enabled && routine.nextRunAt ? routine.nextRunAt : null),
};

export function sortRoutines(entries: RoutineEntry[], sort: Sort): RoutineEntry[] {
  if (!sort) return entries;
  const by = SORTS[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const x = by(a);
    const y = by(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) * sign;
  });
}

/** A press sorts by the column, a second turns it round, a third goes back to the list's own order. */
export function nextSort(sort: Sort, key: SortKey): Sort {
  if (sort?.key !== key) return { key, dir: "asc" };
  return sort.dir === "asc" ? { key, dir: "desc" } : null;
}
