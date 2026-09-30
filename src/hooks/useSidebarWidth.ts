import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";

/**
 * The stored width, and a setter that paints now and saves where the drag
 * stopped. `key` is where it is kept: the sidebar's, or the explorer's.
 */
export function useSidebarWidth(key = "sidebar:width", fallback = 300) {
  const [width, setWidth] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(key)
      .then((raw) => {
        if (cancelled) return;
        const stored = Number(raw);
        setWidth(Number.isFinite(stored) && stored > 0 ? stored : fallback);
      })
      .catch(() => !cancelled && setWidth(fallback));
    return () => {
      cancelled = true;
    };
  }, [key, fallback]);

  // The drag fires on every frame; the store only needs where it stopped.
  const resize = useCallback((next: number) => {
    setWidth(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void api.stateSet(key, String(Math.round(next))).catch(() => {});
    }, 200);
  }, [key]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { width, resize };
}
