import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";

type Pick = { for: string | null; path: string };

const keyOf = (workspaceId: string) => `explorerRoot.${workspaceId}`;

/**
 * The explorer's own pick of worktree, kept per workspace across restarts. It
 * holds while the tab on screen stays in the worktree it was made from (`from`),
 * and gives way to that worktree once the tab moves to another.
 */
export function useExplorerRoot(workspaceId: string | null, from: string | null) {
  const [loaded, setLoaded] = useState<{ workspaceId: string | null; pick: Pick | null }>({ workspaceId, pick: null });

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    api
      .stateGet(keyOf(workspaceId))
      .then((raw) => {
        if (!alive) return;
        let pick: Pick | null = null;
        try {
          const value = raw ? (JSON.parse(raw) as Partial<Pick>) : null;
          if (value && typeof value.path === "string") pick = { for: value.for ?? null, path: value.path };
        } catch {
          // A pick that cannot be read is no pick.
        }
        setLoaded({ workspaceId, pick });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const pick = loaded.workspaceId === workspaceId ? loaded.pick : null;
  const root = pick && pick.for === from ? pick.path : from;

  const choose = useCallback(
    (path: string) => {
      const next = { for: from, path };
      setLoaded({ workspaceId, pick: next });
      if (workspaceId) void api.stateSet(keyOf(workspaceId), JSON.stringify(next)).catch(() => {});
    },
    [workspaceId, from],
  );

  return [root, choose] as const;
}
