import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Session, SessionKind } from "../lib/types";

type CreateInput = {
  name: string;
  provider: string;
  model: string;
  description: string;
};

export function useSessions(workspaceId: string | null) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    api.listSessions(workspaceId).then((list) => {
      if (!cancelled) setSessions(list);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

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

  return { sessions, create, update, rename, remove, reorder };
}
