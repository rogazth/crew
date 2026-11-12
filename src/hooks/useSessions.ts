import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rememberBots } from '../lib/botNames';
import { dispose, onSessionPatch, reconcile, rememberSessions } from '../lib/turnRuntime';
import { client } from '../lib/client';
import * as api from '../lib/api';
import { applyUpdated } from '../lib/sessionList';
import { reloadBotFaces } from './useBotFaces';
import { useWorkspaceLink } from './useEnvLinks';
import type { SessionCreated, SessionsDeleted, SessionUpdated } from '../lib/protocol';
import type { Autonomy, Session, SessionKind, SessionStatus } from '../lib/types';

type CreateInput = {
  name: string;
  provider: string;
  model: string;
  /** Left out, the CLI's own. */
  effort?: string;
  /** Codex's service tier. Left out, the CLI's own. */
  serviceTier?: string;
  description: string;
  autonomy: Autonomy;
  /** The worktree it runs in; left out, the workspace folder. */
  worktree?: string | null;
};

type Registry = Record<string, Session[]>;

const NONE: Session[] = [];

/** Sessions heard of, each added to its workspace's list if that is loaded and lacks it. */
function withHeard(registry: Registry, sessions: Session[]): Registry {
  let next = registry;
  for (const session of sessions) {
    const list = next[session.workspaceId];
    if (!list || list.some((s) => s.id === session.id)) continue;
    next = { ...next, [session.workspaceId]: [...list, session] };
  }
  return next;
}

/**
 * The sessions of every workspace this window has shown. Panes of a hidden
 * workspace stay mounted, so their rows have to stay readable too.
 */
export function useSessions(workspaceId: string | null) {
  const [registry, setRegistry] = useState<Registry>({});
  const asked = useRef(new Set<string>());
  // Every window hears of a session as the daemon makes it, this one too. While
  // this window makes one, what it hears waits: its own lands once `settle` has.
  const making = useRef(0);
  const heard = useRef<Session[]>([]);

  // A workspace on a machine that was down loads once the machine answers.
  const link = useWorkspaceLink(workspaceId);
  const reachable = link === null || (link.status === "online" && !link.mismatch);
  useEffect(() => {
    const id = workspaceId;
    if (!id || !reachable || asked.current.has(id)) return;
    asked.current.add(id);
    void api
      .listSessions(id)
      .then(reconcile)
      .then((list) => {
        // Before the render that shows them, not in an effect after it: a tool
        // row painted with an empty map keeps its uuid for the life of the mount.
        rememberBots(list);
        // Anything made while the list was in flight is already here; the load
        // fills in around it rather than dropping it.
        setRegistry((prev) => {
          const held = prev[id] ?? [];
          const loaded = new Set(list.map((session) => session.id));
          return { ...prev, [id]: [...list, ...held.filter((s) => !loaded.has(s.id))] };
        });
      })
      .catch(() => asked.current.delete(id));
  }, [reachable, workspaceId]);

  const all = useMemo(() => Object.values(registry).flat(), [registry]);

  // The backstop, for the ways a session is made or renamed that do not go
  // through the load above.
  useEffect(() => rememberBots(all), [all]);
  useEffect(() => rememberSessions(all), [all]);

  /** A session is edited by id, whichever workspace holds it. */
  const patchSession = useCallback((id: string, change: (session: Session) => Session) => {
    setRegistry((prev) => {
      const entry = Object.entries(prev).find(([, list]) => list.some((s) => s.id === id));
      if (!entry) return prev;
      const [workspace, list] = entry;
      return { ...prev, [workspace]: list.map((s) => (s.id === id ? change(s) : s)) };
    });
  }, []);

  // The turn runtime keeps going while a tab is closed; its status and resume
  // id land here, whichever workspace is showing.
  useEffect(
    () => onSessionPatch((id, patch) => patchSession(id, (session) => ({ ...session, ...patch }))),
    [patchSession],
  );

  /** The daemon already deleted these, with their worktree or for their age; the list lets them go. */
  const forget = useCallback(async (ids: string[]) => {
    const gone = new Set(ids);
    await Promise.all(ids.map((id) => dispose(id)));
    setRegistry((prev) => {
      let changed = false;
      const next: Registry = {};
      for (const [workspace, list] of Object.entries(prev)) {
        const kept = list.filter((s) => !gone.has(s.id));
        next[workspace] = kept;
        if (kept.length !== list.length) changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  // Settings keeps sessions only so long; the daemon lets the old ones go on its own.
  useEffect(() => {
    const unsubscribe = client.on('sessions-deleted', (payload) => {
      void forget((payload as SessionsDeleted).ids);
    });
    return () => unsubscribe();
  }, [forget]);

  useEffect(() => {
    const unsubscribe = client.on('session-created', (payload) => {
      const created = payload as SessionCreated;
      const session = created.session as unknown as Session;
      // One split off a terminal comes with the face the terminal showed.
      reloadBotFaces();
      if (making.current > 0) heard.current.push(session);
      else setRegistry((prev) => withHeard(prev, [session]));
    });
    // A session its provider named comes back renamed, a Claude terminal that
    // moved to a new conversation renamed and rebound; a bot that rewrote its
    // description comes back with it.
    const unsubscribeUpdated = client.on('session-updated', (payload) => {
      const row = (payload as SessionUpdated).session as unknown as Session;
      patchSession(row.id, (session) => applyUpdated(session, row));
    });
    return () => {
      unsubscribe();
      unsubscribeUpdated();
    };
  }, [patchSession]);

  // `settle` lets a caller hold the list back so the row and its sheet land together.
  const create = useCallback(
    async (kind: SessionKind, input: CreateInput, settle?: Promise<unknown>) => {
      if (!workspaceId) return null;
      making.current += 1;
      let session: Session | null = null;
      try {
        session = await api.createSession(workspaceId, kind, input);
        await settle;
      } finally {
        making.current -= 1;
        const made = session;
        const rest = making.current === 0 ? heard.current.splice(0) : [];
        setRegistry((prev) => {
          const list = prev[workspaceId] ?? [];
          const next = made && !list.some((s) => s.id === made.id) ? { ...prev, [workspaceId]: [...list, made] } : prev;
          return withHeard(next, rest);
        });
      }
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
        const bots = kind === 'bot' ? group : list.filter((session) => session.kind === 'bot');
        const terminals =
          kind === 'terminal' ? group : list.filter((session) => session.kind === 'terminal');
        // Children are listed under whoever started them, and move with nothing.
        const children = list.filter((session) => session.kind === 'child');
        return { ...prev, [workspaceId]: [...bots, ...terminals, ...children] };
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

  /** Terminals report through here; bot and child sessions are written by the runtime. */
  const setStatus = useCallback(
    (id: string, status: SessionStatus) => {
      // The daemon stamps the row as it stores the status; the list keeps pace.
      patchSession(id, (session) => ({ ...session, status, updatedAt: Date.now() }));
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
  return { sessions, all, create, update, rename, remove, forget, reorder, setStatus, dropWorkspace };
}
