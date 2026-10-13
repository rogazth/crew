import { useCallback, useMemo, useState } from "react";
import * as api from "../lib/api";
import { finishedKeys, panelEntries, visibleEntries, type PanelEntry } from "../lib/backgroundPanel";
import type { Process } from "../lib/processes";
import type { Session } from "../lib/types";
import { useBackground } from "./useBackground";

/**
 * A session's background panel: the board the daemon keeps, the children it
 * started and the processes it started, as one list. Stop goes to whoever
 * owns the work; Clear finished drops the board's own entries in the daemon
 * and has it keep the keys of the ended children and runs, which belong to
 * other lists, so they stay off the panel after a reload and in every window.
 */
export function useBackgroundPanel(session: Session, sessions: readonly Session[], processes: readonly Process[]) {
  const board = useBackground(session.id);
  const all = useMemo(() => panelEntries(board, sessions, processes, session), [board, sessions, processes, session]);
  const cleared = useMemo<ReadonlySet<string>>(() => new Set(board?.hidden), [board?.hidden]);
  const entries = useMemo(() => visibleEntries(all, cleared), [all, cleared]);
  /** What went wrong stopping an entry, by entry id, for its row to say. */
  const [failed, setFailed] = useState<Record<string, string>>({});

  const stop = useCallback(
    (entry: PanelEntry) => {
      const { source } = entry;
      setFailed(({ [entry.id]: _, ...rest }) => rest);
      const request = (() => {
        switch (source.type) {
          case "command":
            return api.backgroundStop(session.id, source.id);
          // A Crew child is a chat Crew drives: stopping it ends its turn, not a terminal.
          case "session":
            return api.turnStop(source.id);
          case "process": {
            const process = processes.find((row) => row.id === source.id);
            return process ? api.runCommand("stop", process.workspaceId, process.id, source.worktree).then(() => undefined) : Promise.resolve();
          }
        }
      })();
      void request.catch((error: unknown) =>
        setFailed((prev) => ({ ...prev, [entry.id]: error instanceof Error ? error.message : String(error) })),
      );
    },
    [processes, session.id],
  );

  const clear = useCallback(() => {
    const keys = finishedKeys(all).filter((key) => !cleared.has(key));
    if (keys.length > 0 || all.some((entry) => entry.source.type === "command" && entry.state !== "running")) {
      void api.backgroundClear(session.id, undefined, keys).catch(() => {});
    }
  }, [all, cleared, session.id]);

  return { board, all, entries, failed, stop, clear };
}
