import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";

export type ExplorerMode = "files" | "search";

type View = { open: boolean; mode: ExplorerMode };

const CLOSED: View = { open: false, mode: "files" };
const viewKey = (workspaceId: string) => `explorer:view:${workspaceId}`;

/** Where the keyboard goes when the explorer is asked for: a new token each time. */
export type ExplorerFocus = { mode: ExplorerMode; token: number; query?: string };

/**
 * The explorer beside the tabs: whether it shows, which half, and what the
 * last shortcut asked of it. The first two are each workspace's own, kept
 * across launches; a workspace it was never opened in starts with it closed.
 */
export function useExplorer(workspaceId: string | null) {
  const [views, setViews] = useState<Record<string, View>>({});
  const [focus, setFocus] = useState<ExplorerFocus | null>(null);
  // A shortcut pressed before a workspace's stored view arrives wins over it.
  const touched = useRef(new Set<string>());
  // The last shortcut was asked of the workspace left behind: the one switched
  // to shows its explorer without taking the keyboard.
  const [focusedIn, setFocusedIn] = useState(workspaceId);
  if (focusedIn !== workspaceId) {
    setFocusedIn(workspaceId);
    setFocus(null);
  }

  const loaded = workspaceId ? views[workspaceId] !== undefined : true;
  useEffect(() => {
    if (!workspaceId || loaded) return;
    let cancelled = false;
    api
      .stateGet(viewKey(workspaceId))
      .then((raw) => {
        const stored = raw ? (JSON.parse(raw) as Partial<View>) : {};
        if (cancelled || touched.current.has(workspaceId)) return;
        const view: View = { open: stored.open === true, mode: stored.mode === "search" ? "search" : "files" };
        setViews((prev) => ({ ...prev, [workspaceId]: view }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, loaded]);

  const view = (workspaceId && views[workspaceId]) || CLOSED;

  const show = useCallback(
    (next: View) => {
      if (!workspaceId) return;
      touched.current.add(workspaceId);
      setViews((prev) => ({ ...prev, [workspaceId]: next }));
      void api.stateSet(viewKey(workspaceId), JSON.stringify(next)).catch(() => {});
    },
    [workspaceId],
  );

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

  /** A removed workspace's view goes with it. */
  const forget = useCallback((id: string) => {
    touched.current.delete(id);
    setViews(({ [id]: _, ...rest }) => rest);
    void api.stateDelete(viewKey(id)).catch(() => {});
  }, []);

  return {
    open: view.open,
    mode: view.mode,
    focus,
    toggle,
    forget,
    setMode: (mode: ExplorerMode) => show({ open: true, mode }),
    close: () => show({ open: false, mode: view.mode }),
  };
}
