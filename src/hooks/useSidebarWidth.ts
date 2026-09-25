import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";

const KEY = "sidebar:width";
const DEFAULT = 300;

/** kumo reads its width once, so nothing renders until the stored value arrives. */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => {
        if (cancelled) return;
        const stored = Number(raw);
        setWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT);
      })
      .catch(() => !cancelled && setWidth(DEFAULT));
    return () => {
      cancelled = true;
    };
  }, []);

  // The drag fires on every frame; the store only needs where it stopped.
  const commit = useCallback((next: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void api.stateSet(KEY, String(Math.round(next))).catch(() => {});
    }, 200);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { width, commit };
}
