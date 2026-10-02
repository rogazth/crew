import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { onWorkspacesChanged } from "../lib/client/registry";
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
    // Home is made before the first list, so a fresh install lands in it. A
    // daemon that cannot make it still shows the projects.
    api
      .homeWorkspace()
      .catch(() => null)
      .then(() => Promise.all([api.listWorkspaces(), api.getActiveWorkspace()]))
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

  // A machine that was offline or slow at launch answers later; its workspaces join the rail then.
  useEffect(
    () =>
      onWorkspacesChanged(() => {
        void api.listWorkspaces().then(setWorkspaces, () => {});
      }),
    [],
  );

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

  const adopt = useCallback(
    (workspace: Workspace) => {
      setWorkspaces((prev) => (prev.some((item) => item.id === workspace.id) ? prev : [...prev, workspace]));
      activate(workspace.id);
    },
    [activate],
  );

  const rename = useCallback(async (id: string, name: string) => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === id ? { ...w, name } : w)),
    );
    await api.renameWorkspace(id, name);
  }, []);

  // Home stands apart from the projects: first on the rail, never reordered or removed.
  const home = useMemo(() => workspaces.find((w) => w.home) ?? null, [workspaces]);
  const projects = useMemo(() => workspaces.filter((w) => !w.home), [workspaces]);

  const remove = useCallback(
    async (id: string) => {
      const next = workspaces.filter((w) => w.id !== id);
      await api.deleteWorkspace(id);
      setWorkspaces(next);
      if (id === activeId) activate(next.find((w) => !w.home)?.id ?? home?.id ?? null);
    },
    [workspaces, activeId, activate, home],
  );

  // Keyboard switching walks the rail top to bottom, home first, and wraps, like tab cycling.
  const step = useCallback(
    (delta: number) => {
      const order = home ? [home, ...projects] : projects;
      const index = order.findIndex((w) => w.id === activeId);
      const count = order.length;
      if (count < 2) return;
      const next = order[(((index === -1 ? 0 : index) + delta) % count + count) % count];
      if (next) activate(next.id);
    },
    [activate, activeId, home, projects],
  );

  /** ⌘1‥9: the projects, counted from the first under home. */
  const activateAt = useCallback(
    (index: number) => {
      const target = projects[index];
      if (target && target.id !== activeId) activate(target.id);
    },
    [activate, activeId, projects],
  );

  const activateHome = useCallback(() => {
    if (home && home.id !== activeId) activate(home.id);
  }, [activate, activeId, home]);

  /** `ids` are the projects in their new order; home keeps its place. */
  const reorder = useCallback((ids: string[]) => {
    setWorkspaces((prev) => {
      const map = new Map(prev.map((workspace) => [workspace.id, workspace]));
      const next = [
        ...prev.filter((workspace) => workspace.home),
        ...ids
          .map((id) => map.get(id))
          .filter((workspace): workspace is Workspace => workspace !== undefined && !workspace.home),
      ];
      return next.length === prev.length ? next : prev;
    });
    void api.reorderWorkspaces(ids);
  }, []);

  const active = resolveActive(workspaces, activeId);
  return {
    workspaces,
    home,
    projects,
    active,
    loading,
    error,
    activate,
    activateAt,
    activateHome,
    step,
    create,
    adopt,
    rename,
    remove,
    reorder,
  };
}
