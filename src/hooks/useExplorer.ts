import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";

export type ExplorerMode = "files" | "search";

const KEY = "explorer:view";

/** Where the keyboard goes when the explorer is asked for: a new token each time. */
export type ExplorerFocus = { mode: ExplorerMode; token: number; query?: string };

/**
 * The explorer beside the tabs: whether it shows, which half, and what the
 * last shortcut asked of it. The first two are kept across launches.
 */
export function useExplorer() {
  const [view, setView] = useState<{ open: boolean; mode: ExplorerMode }>({ open: false, mode: "files" });
  const [focus, setFocus] = useState<ExplorerFocus | null>(null);
  // A shortcut pressed before the stored view arrives wins over it.
  const touched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => {
        const stored = raw ? (JSON.parse(raw) as Partial<typeof view>) : {};
        if (cancelled || touched.current) return;
        setView({ open: stored.open === true, mode: stored.mode === "search" ? "search" : "files" });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const show = useCallback((next: { open: boolean; mode: ExplorerMode }) => {
    touched.current = true;
    setView(next);
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  /**
   * ⌘⇧E and ⌘⇧F: the explorer opens on that half with the keyboard in it;
   * asked again while that half shows, it closes, wherever the keyboard is.
   */
  const toggle = useCallback(
    (mode: ExplorerMode, query?: string) => {
      if (view.open && view.mode === mode) {
        show({ open: false, mode });
        return;
      }
      show({ open: true, mode });
      setFocus((current) => ({ mode, token: (current?.token ?? 0) + 1, ...(query ? { query } : {}) }));
    },
    [show, view],
  );

  return {
    open: view.open,
    mode: view.mode,
    focus,
    toggle,
    setMode: (mode: ExplorerMode) => show({ open: true, mode }),
    close: () => show({ open: false, mode: view.mode }),
  };
}
