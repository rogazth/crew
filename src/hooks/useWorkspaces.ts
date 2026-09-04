import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { open } from "../lib/host";
import type { Workspace } from "../lib/types";
import { nameFromPath, resolveActive } from "../lib/workspaces";

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listWorkspaces(), api.getActiveWorkspace()])
      .then(([list, active]) => {
        if (cancelled) return;
        setWorkspaces(list);
        setActiveId(resolveActive(list, active)?.id ?? null);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const activate = useCallback((id: string | null) => {
    setActiveId(id);
    void api.setActiveWorkspace(id);
  }, []);

  const create = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      const workspace = await api.createWorkspace(nameFromPath(picked), picked);
      setWorkspaces((prev) => [...prev, workspace]);
      activate(workspace.id);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [activate]);

  const rename = useCallback(async (id: string, name: string) => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === id ? { ...w, name } : w)),
    );
    await api.renameWorkspace(id, name);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      const next = workspaces.filter((w) => w.id !== id);
      await api.deleteWorkspace(id);
      setWorkspaces(next);
      if (id === activeId) activate(next[0]?.id ?? null);
    },
    [workspaces, activeId, activate],
  );

  // Keyboard switching walks the sidebar order and wraps, like tab cycling.
  const step = useCallback(
    (delta: number) => {
      const index = workspaces.findIndex((w) => w.id === activeId);
      const count = workspaces.length;
      if (count < 2) return;
      const next = workspaces[(((index === -1 ? 0 : index) + delta) % count + count) % count];
      if (next) activate(next.id);
    },
    [activate, activeId, workspaces],
  );

  const activateAt = useCallback(
    (index: number) => {
      const target = workspaces[index];
      if (target && target.id !== activeId) activate(target.id);
    },
    [activate, activeId, workspaces],
  );

  const reorder = useCallback((ids: string[]) => {
    setWorkspaces((prev) => {
      const map = new Map(prev.map((workspace) => [workspace.id, workspace]));
      const next = ids
        .map((id) => map.get(id))
        .filter((workspace): workspace is Workspace => workspace !== undefined);
      return next.length === prev.length ? next : prev;
    });
    void api.reorderWorkspaces(ids);
  }, []);

  const active = resolveActive(workspaces, activeId);
  return {
    workspaces,
    active,
    loading,
    error,
    activate,
    activateAt,
    step,
    create,
    rename,
    remove,
    reorder,
  };
}
