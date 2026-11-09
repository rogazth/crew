import { useCallback, useEffect, useMemo, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import * as api from "../lib/api";
import { client } from "../lib/client";
import { isLive, liveRuns, replayEvents, rerunEnv, runIn, runKey, startableIn, type Process, type ProcessEvent } from "../lib/processes";
import type { ProcessRemoved } from "../lib/protocol";

/** How long a restart reads "Restarting…" at least: a fast one would otherwise never show it. */
const RESTART_SHOWN_MS = 800;

/**
 * The workspace's processes, kept current by the daemon's events: a process
 * changes state on its own (it crashes, a backoff runs out), and an agent can
 * create one at any time. `null` while loading.
 */
export function useProcesses(workspaceId: string | null) {
  const [loaded, setLoaded] = useState<{ workspaceId: string; list: Process[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Runs restarted by a press here, by `runKey`, held until the restart has had its time on screen. */
  const [restarting, setRestarting] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let latest = 0;
    // Each load in flight keeps the events heard meanwhile: its answer may
    // have been read before them, and they go back on top of it.
    const heard = new Set<ProcessEvent[]>();
    const load = () => {
      const mine = ++latest;
      const events: ProcessEvent[] = [];
      heard.add(events);
      const settle = (list: Process[]) => {
        heard.delete(events);
        if (cancelled || mine !== latest) return;
        setLoaded({ workspaceId, list: replayEvents(list, events) });
      };
      api
        .listProcesses(workspaceId)
        .then(settle)
        .catch(() => settle([]));
    };
    const hear = (event: ProcessEvent) => {
      for (const events of heard) events.push(event);
      setLoaded((prev) => (prev?.workspaceId === workspaceId ? { workspaceId, list: replayEvents(prev.list, [event]) } : prev));
    };
    load();
    const offChanged = client.on("process-changed", (payload) => {
      const process = payload as Process;
      if (process.workspaceId === workspaceId) hear({ kind: "changed", process });
    });
    const offRemoved = client.on("process-removed", (payload) => {
      const gone = payload as ProcessRemoved;
      if (gone.workspaceId === workspaceId) hear({ kind: "removed", id: gone.id });
    });
    // Events sent while the socket was down are lost; the list is not.
    const offReconnect = client.onReconnect(load);
    return () => {
      cancelled = true;
      offChanged();
      offRemoved();
      offReconnect();
    };
  }, [workspaceId]);

  const processes = useMemo(() => {
    const list = loaded && loaded.workspaceId === workspaceId ? loaded.list : null;
    if (!list || restarting.size === 0) return list;
    return list.map((process) =>
      process.runs.some((run) => restarting.has(runKey(process.id, run.worktree)))
        ? {
            ...process,
            runs: process.runs.map((run) =>
              restarting.has(runKey(process.id, run.worktree))
                ? { ...run, state: "starting" as const, restarts: Math.max(1, run.restarts), url: null }
                : run,
            ),
          }
        : process,
    );
  }, [loaded, workspaceId, restarting]);

  /**
   * Acts on one run: `worktree` null is the main checkout. A failure is kept
   * for the view to show, not thrown.
   */
  const run = useCallback(
    async (command: api.RunCommand, process: Process, worktree: string | null, env?: Record<string, string>) => {
      setError(null);
      const key = runKey(process.id, worktree);
      if (command === "restart") setRestarting((prev) => new Set(prev).add(key));
      try {
        const done = api.runCommand(command, process.workspaceId, process.id, worktree, env);
        await (command === "restart" ? Promise.all([done, new Promise((wait) => setTimeout(wait, RESTART_SHOWN_MS))]) : done);
      } catch (failure) {
        setError(String(failure).replace(/^Error:\s*/, ""));
      } finally {
        if (command === "restart")
          setRestarting((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
      }
    },
    [],
  );

  /** Every command not up in `worktree`, started there, each with the env its run had. */
  const startAll = useCallback(
    async (worktree: string | null) => {
      const list = processes ?? [];
      await Promise.all(
        startableIn(list, worktree).map((process) => run("start", process, worktree, rerunEnv(process, runIn(process, worktree)))),
      );
    },
    [processes, run],
  );

  /** Every run up in the workspace, in any worktree, stopped. */
  const stopAll = useCallback(async () => {
    await Promise.all(liveRuns(processes ?? []).map(({ process, run: up }) => run("stop", process, up.worktree)));
  }, [processes, run]);

  const reorder = useCallback(
    (ids: string[]) => {
      if (!workspaceId) return;
      setLoaded((prev) => {
        if (prev?.workspaceId !== workspaceId) return prev;
        const byId = new Map(prev.list.map((process) => [process.id, process]));
        return { workspaceId, list: ids.flatMap((id) => byId.get(id) ?? []) };
      });
      void api.reorderProcesses(workspaceId, ids).catch(() => {});
    },
    [workspaceId],
  );

  return { processes, error, clearError: () => setError(null), run, startAll, stopAll, reorder };
}

export type Processes = ReturnType<typeof useProcesses>;

/** Removed for good, every run's logs too, once the user says so. */
export function deleteConfirm(process: Process): Confirm {
  const live = process.runs.filter(isLive).length;
  return {
    title: `Delete "${process.name}"?`,
    description:
      live === 0
        ? "Its logs go with it."
        : `${live === 1 ? "Its run stops" : `Its ${live} runs stop`} first. The logs go with it.`,
    action: "Delete",
    onConfirm: async () => {
      await api.deleteProcess(process.workspaceId, process.id);
    },
  };
}
