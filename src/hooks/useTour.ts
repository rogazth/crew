import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { parseTour, TOUR_KEY, tourSteps, type TourMemory } from "../lib/gettingStarted";
import type { Session, Workspace } from "../lib/types";

/** Home's getting-started tour: its steps, and what the window has to remember for it. */
export function useTour(home: Workspace | null, projects: Workspace[], sessions: Session[]) {
  const [memory, setMemory] = useState<TourMemory | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(TOUR_KEY)
      .then((raw) => !cancelled && setMemory(parseTour(raw)))
      .catch(() => !cancelled && setMemory(parseTour(null)));
    return () => {
      cancelled = true;
    };
  }, []);

  const remember = useCallback((patch: Partial<TourMemory>) => {
    setMemory((prev) => {
      const next = { ...(prev ?? parseTour(null)), ...patch };
      if (prev && prev.browser === next.browser && prev.dismissed === next.dismissed) return prev;
      void api.stateSet(TOUR_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const steps = useMemo(
    () => (memory ? tourSteps(home, projects, sessions, memory) : []),
    [home, memory, projects, sessions],
  );
  // Until the memory is read nothing shows, so a finished tour never flashes.
  const shown = memory !== null && !memory.dismissed && steps.some((step) => !step.done);

  return {
    steps,
    shown,
    triedBrowser: () => remember({ browser: true }),
    dismiss: () => remember({ dismissed: true }),
  };
}
