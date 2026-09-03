import { useCallback, useEffect, useState } from "react";
import { dispose, onSessionPatch, reconcile } from "../lib/agentRuntime";
import * as api from "../lib/api";
import type { Autonomy, Session, SessionKind, SessionStatus } from "../lib/types";

type CreateInput = {
  name: string;
  provider: string;
  model: string;
  description: string;
  autonomy: Autonomy;
};

export function useSessions(workspaceId: string | null) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    api
      .listSessions(workspaceId)
      .then(reconcile)
      .then((list) => {
        if (!cancelled) setSessions(list);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // The agent runtime keeps going while a tab is closed; its status and resume
  // id land here, whichever workspace is showing.
  useEffect(
    () =>
      onSessionPatch((id, patch) => {
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
      }),
    [],
  );

  const create = useCallback(
    async (kind: SessionKind, input: CreateInput) => {
      if (!workspaceId) return null;
      const session = await api.createSession(workspaceId, kind, input);
      setSessions((prev) => [...prev, session]);
      return session;
    },
    [workspaceId],
  );

  const remove = useCallback(async (id: string) => {
    await dispose(id);
    await api.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    await api.renameSession(id, name);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  const reorder = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setSessions((prev) => {
      const kind = prev.find((session) => session.id === ids[0])?.kind;
      if (!kind) return prev;
      const group = ids
        .map((id) => prev.find((session) => session.id === id))
        .filter((session): session is Session => session !== undefined);
      const agents = kind === "agent" ? group : prev.filter((session) => session.kind === "agent");
      const terminals =
        kind === "terminal" ? group : prev.filter((session) => session.kind === "terminal");
      return [...agents, ...terminals];
    });
    void api.reorderSessions(ids);
  }, []);

  const update = useCallback(
    async (
      id: string,
      input: CreateInput & { notifications: boolean },
    ) => {
      await api.updateSession(id, input);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...input } : s)),
      );
    },
    [],
  );

  /** Terminals report through here; agent sessions are written by the runtime. */
  const setStatus = useCallback((id: string, status: SessionStatus) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)));
    void api.setSessionStatus(id, status).catch(() => {});
  }, []);

  return { sessions, create, update, rename, remove, reorder, setStatus };
}
