import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { fromRow, type Routine } from "../lib/routines";
import { onRoutinesChanged } from "../lib/scheduler";
import type { Session } from "../lib/types";

/** A routine with the agent that owns it and the directory it runs in. */
export type RoutineEntry = { routine: Routine; session: Session; cwd: string };

/**
 * Every routine in the app, not just the active workspace's: the scheduler fires
 * them all, so the screen that manages them has to show them all. `null` while loading.
 */
export function useRoutines(): RoutineEntry[] | null {
  const [entries, setEntries] = useState<RoutineEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .listRoutines()
        .then((rows) => {
          if (cancelled) return;
          setEntries(rows.map((row) => ({ ...row, routine: fromRow(row.routine) })));
        })
        .catch(() => {
          if (!cancelled) setEntries([]);
        });
    void load();
    // Saves, deletes and finished runs all land through the scheduler.
    const unsubscribe = onRoutinesChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return entries;
}
