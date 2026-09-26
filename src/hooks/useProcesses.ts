import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import * as api from "../lib/api";
import { client } from "../lib/client";
import { isLive, removeProcess, upsertProcess, type Process } from "../lib/processes";
import type { ProcessRemoved } from "../lib/protocol";

/**
 * The workspace's processes, kept current by the daemon's events: a process
 * changes state on its own (it crashes, a backoff runs out), and an agent can
 * create one at any time. `null` while loading.
 */
export function useProcesses(workspaceId: string | null) {
  const [loaded, setLoaded] = useState<{ workspaceId: string; list: Process[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const load = () =>
      api
        .listProcesses(workspaceId)
        .then((list) => !cancelled && setLoaded({ workspaceId, list }))
        .catch(() => !cancelled && setLoaded({ workspaceId, list: [] }));
    void load();
    const offChanged = client.on("process-changed", (payload) => {
      const process = payload as Process;
      if (process.workspaceId !== workspaceId) return;
      setLoaded((prev) =>
        prev?.workspaceId === workspaceId ? { workspaceId, list: upsertProcess(prev.list, process) } : prev,
      );
    });
    const offRemoved = client.on("process-removed", (payload) => {
      const gone = payload as ProcessRemoved;
      if (gone.workspaceId !== workspaceId) return;
      setLoaded((prev) =>
        prev?.workspaceId === workspaceId ? { workspaceId, list: removeProcess(prev.list, gone.id) } : prev,
      );
    });
    // Events sent while the socket was down are lost; the list is not.
    const offReconnect = client.onReconnect(() => void load());
    return () => {
      cancelled = true;
      offChanged();
      offRemoved();
      offReconnect();
    };
  }, [workspaceId]);

  const processes = loaded && loaded.workspaceId === workspaceId ? loaded.list : null;

  /** Runs one command; a failure is kept for the view to show, not thrown. */
  const run = useCallback(
    async (command: api.ProcessCommand, process: Process) => {
      setError(null);
      try {
        await api.processCommand(command, process.workspaceId, process.id);
      } catch (failure) {
        setError(String(failure).replace(/^Error:\s*/, ""));
      }
    },
    [],
  );

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

  return { processes, error, clearError: () => setError(null), run, reorder };
}

export type Processes = ReturnType<typeof useProcesses>;

/** Removed for good, logs and all, once the user says so. */
export function deleteConfirm(process: Process): Confirm {
  return {
    title: `Delete "${process.name}"?`,
    description: isLive(process) ? "It stops first. Its logs go with it." : "Its logs go with it.",
    action: "Delete",
    onConfirm: async () => {
      await api.processCommand("delete", process.workspaceId, process.id);
    },
  };
}
