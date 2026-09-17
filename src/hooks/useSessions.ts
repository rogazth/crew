import { useCallback, useEffect, useState } from "react";
import { rememberAgents } from "../lib/agentNames";
import { dispose, onSessionPatch, reconcile } from "../lib/agentRuntime";
import { client } from "../lib/client";
import * as api from "../lib/api";
import type { SessionCreated } from "../lib/protocol";
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
        // Before the render that shows them, not in an effect after it: a tool
        // row painted with an empty map keeps its uuid for the life of the mount.
        rememberAgents(list);
        if (!cancelled) setSessions(list);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // The backstop, for the ways a session is made or renamed that do not go
  // through the load above.
  useEffect(() => rememberAgents(sessions), [sessions]);

  // The agent runtime keeps going while a tab is closed; its status and resume
  // id land here, whichever workspace is showing.
  useEffect(
    () =>
      onSessionPatch((id, patch) => {
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
      }),
    [],
  );

  useEffect(() => {
    const unsubscribe = client.on("session-created", (payload) => {
      const created = payload as SessionCreated;
      if (created.session.workspaceId === workspaceId) {
        const session = created.session as unknown as Session;
        setSessions((prev) => [...prev, session]);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [workspaceId]);

  // `settle` lets a caller hold the list back so the row and its sheet land together.
  const create = useCallback(
    async (kind: SessionKind, input: CreateInput, settle?: Promise<unknown>) => {
      if (!workspaceId) return null;
      const session = await api.createSession(workspaceId, kind, input);
      await settle;
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
      settle?: Promise<unknown>,
    ) => {
      await api.updateSession(id, input);
      await settle;
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
