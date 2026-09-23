import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";

const KEY = "sidebar:width";
const DEFAULT = 264;

/** kumo reads its width once, so nothing renders until the stored value arrives. */
export function useSidebarWidth() {
  const [width, setWidth] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<number | null>(null);

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

  const save = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (next !== null) void api.stateSet(KEY, String(Math.round(next))).catch(() => {});
  }, []);

  // The drag fires on every frame; the store only needs where it stopped.
  const commit = useCallback(
    (next: number) => {
      pending.current = next;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(save, 200);
    },
    [save],
  );

  // Unmounting mid-debounce saves at once, or the end of the drag is lost.
  useEffect(() => save, [save]);

  return { width, commit };
}
