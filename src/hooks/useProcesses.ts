import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import * as api from "../lib/api";
import { client } from "../lib/client";
import { isLive, replayEvents, type Process, type ProcessEvent } from "../lib/processes";
import type { ProcessRemoved } from "../lib/protocol";

/**
 * The workspace's processes, kept current by the daemon's events: a process
 * changes state on its own (it crashes, a backoff runs out), and an agent can
 * create one at any time. `null` while loading.
 */
export function useProcesses(workspaceId: string | null) {
  const [loaded, setLoaded] = useState<{ workspaceId: string; list: Process[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

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
  }, [workspaceId, reloads]);

  const processes = loaded && loaded.workspaceId === workspaceId ? loaded.list : null;

  /**
   * Runs one command; a failure is kept for the view to show, not thrown.
   * An approval names the revision the user read; refused because the
   * process changed meanwhile, the list is read again for them to review.
   */
  const run = useCallback(async (command: api.ProcessCommand | "approve", process: Process) => {
    setError(null);
    try {
      if (command === "approve") await api.approveProcess(process.workspaceId, process.id, process.revision);
      else await api.processCommand(command, process.workspaceId, process.id);
    } catch (failure) {
      setError(String(failure).replace(/^Error:\s*/, ""));
      if (command === "approve") setReloads((n) => n + 1);
    }
  }, []);

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
