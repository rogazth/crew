import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rememberAgents } from '../lib/agentNames';
import { dispose, onSessionPatch, reconcile } from '../lib/agentRuntime';
import { client } from '../lib/client';
import * as api from '../lib/api';
import type { SessionCreated } from '../lib/protocol';
import type { Autonomy, Session, SessionKind, SessionStatus } from '../lib/types';

type CreateInput = {
  name: string;
  provider: string;
  model: string;
  description: string;
  autonomy: Autonomy;
};

type Registry = Record<string, Session[]>;

const NONE: Session[] = [];

/**
 * The sessions of every workspace this window has shown. Panes of a hidden
 * workspace stay mounted, so their rows have to stay readable too.
 */
export function useSessions(workspaceId: string | null) {
  const [registry, setRegistry] = useState<Registry>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const id = workspaceId;
    if (!id || asked.current.has(id)) return;
    asked.current.add(id);
    void api
      .listSessions(id)
      .then(reconcile)
      .then((list) => {
        // Before the render that shows them, not in an effect after it: a tool
        // row painted with an empty map keeps its uuid for the life of the mount.
        rememberAgents(list);
        // Anything made while the list was in flight is already here; the load
        // fills in around it rather than dropping it.
        setRegistry((prev) => {
          const held = prev[id] ?? [];
          const loaded = new Set(list.map((session) => session.id));
          return { ...prev, [id]: [...list, ...held.filter((s) => !loaded.has(s.id))] };
        });
      })
      .catch(() => asked.current.delete(id));
  }, [workspaceId]);

  const all = useMemo(() => Object.values(registry).flat(), [registry]);

  // The backstop, for the ways a session is made or renamed that do not go
  // through the load above.
  useEffect(() => rememberAgents(all), [all]);

  /** A session is edited by id, whichever workspace holds it. */
  const patchSession = useCallback((id: string, change: (session: Session) => Session) => {
    setRegistry((prev) => {
      const entry = Object.entries(prev).find(([, list]) => list.some((s) => s.id === id));
      if (!entry) return prev;
      const [workspace, list] = entry;
      return { ...prev, [workspace]: list.map((s) => (s.id === id ? change(s) : s)) };
    });
  }, []);

  // The agent runtime keeps going while a tab is closed; its status and resume
  // id land here, whichever workspace is showing.
  useEffect(
    () => onSessionPatch((id, patch) => patchSession(id, (session) => ({ ...session, ...patch }))),
    [patchSession],
  );

  useEffect(() => {
    const unsubscribe = client.on('session-created', (payload) => {
      const created = payload as SessionCreated;
      const session = created.session as unknown as Session;
      setRegistry((prev) => {
        const list = prev[session.workspaceId];
        if (!list || list.some((s) => s.id === session.id)) return prev;
        return { ...prev, [session.workspaceId]: [...list, session] };
      });
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // `settle` lets a caller hold the list back so the row and its sheet land together.
  const create = useCallback(
    async (kind: SessionKind, input: CreateInput, settle?: Promise<unknown>) => {
      if (!workspaceId) return null;
      const session = await api.createSession(workspaceId, kind, input);
      await settle;
      setRegistry((prev) => ({ ...prev, [workspaceId]: [...(prev[workspaceId] ?? []), session] }));
      return session;
    },
    [workspaceId],
  );

  const remove = useCallback(async (id: string) => {
    await dispose(id);
    await api.deleteSession(id);
    setRegistry((prev) => {
      const entry = Object.entries(prev).find(([, list]) => list.some((s) => s.id === id));
      if (!entry) return prev;
      const [workspace, list] = entry;
      return { ...prev, [workspace]: list.filter((s) => s.id !== id) };
    });
  }, []);

  const rename = useCallback(
    async (id: string, name: string) => {
      await api.renameSession(id, name);
      patchSession(id, (session) => ({ ...session, name }));
    },
    [patchSession],
  );

  const reorder = useCallback(
    (ids: string[]) => {
      if (ids.length === 0 || !workspaceId) return;
      setRegistry((prev) => {
        const list = prev[workspaceId];
        if (!list) return prev;
        const kind = list.find((session) => session.id === ids[0])?.kind;
        if (!kind) return prev;
        const group = ids
          .map((id) => list.find((session) => session.id === id))
          .filter((session): session is Session => session !== undefined);
        const agents = kind === 'agent' ? group : list.filter((session) => session.kind === 'agent');
        const terminals =
          kind === 'terminal' ? group : list.filter((session) => session.kind === 'terminal');
        return { ...prev, [workspaceId]: [...agents, ...terminals] };
      });
      void api.reorderSessions(ids);
    },
    [workspaceId],
  );

  const update = useCallback(
    async (id: string, input: CreateInput & { notifications: boolean }, settle?: Promise<unknown>) => {
      await api.updateSession(id, input);
      await settle;
      patchSession(id, (session) => ({ ...session, ...input }));
    },
    [patchSession],
  );

  /** Terminals report through here; agent sessions are written by the runtime. */
  const setStatus = useCallback(
    (id: string, status: SessionStatus) => {
      patchSession(id, (session) => ({ ...session, status }));
      void api.setSessionStatus(id, status).catch(() => {});
    },
    [patchSession],
  );

  /** The workspace was removed; the daemon dropped its sessions with it. */
  const dropWorkspace = useCallback((id: string) => {
    asked.current.delete(id);
    setRegistry((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const sessions = (workspaceId ? registry[workspaceId] : undefined) ?? NONE;
  return { sessions, all, create, update, rename, remove, reorder, setStatus, dropWorkspace };
}
