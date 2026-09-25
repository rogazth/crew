import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";

const KEY = "sidebar:width";
const DEFAULT = 300;

/** The stored width, and a setter that paints now and saves where the drag stopped. */
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
  const resize = useCallback((next: number) => {
    setWidth(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void api.stateSet(KEY, String(Math.round(next))).catch(() => {});
    }, 200);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { width, resize };
}
