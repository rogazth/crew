/**
 * One interface, two implementations: the fixtures, and the real daemon.
 *
 * A prototype talks to this and never to either directly, so flipping a running
 * window from canned data to a live `crewd` is one call. Everything is async
 * even where the fixtures answer instantly — a component written against a
 * synchronous mock has to be rewritten to meet a socket, and that rewrite is
 * exactly the work this exists to avoid.
 */
import type {
  ApprovalDecision,
  AttachedFile,
  Autonomy,
  ProjectFile,
  Routine,
  SearchHit,
  Session,
  SessionKind,
  SessionStatus,
  ThreadState,
  Workspace,
} from "./types";

export type { ThreadState };
import type { TerminalLine } from "./data/terminal";

export type ThreadHandle = {
  /**
   * The listener fires **synchronously with the current state** before this
   * returns, so the unsubscribe function does not exist yet inside that first
   * call. Hold it in a mutable box if the listener needs to unsubscribe itself.
   */
  subscribe(listener: (state: ThreadState) => void): () => void;
  snapshot(): ThreadState;
  send(text: string, files?: AttachedFile[]): void | Promise<void>;
  stop(): void | Promise<void>;
  approve(requestId: number, decision: ApprovalDecision): void | Promise<void>;
  answer(requestId: number, answers: Record<string, string> | null): void | Promise<void>;
  /** Page backwards. Resolves false when there is nothing older. */
  loadEarlier?(): Promise<boolean>;
  dispose?(): void;
};

export type SessionDraft = {
  name: string;
  provider: string;
  model: string;
  description: string;
  autonomy: Autonomy;
  notifications?: boolean;
};

export type SearchInput = {
  query: string;
  sessionIds?: string[];
  from?: number;
  sort?: "relevance" | "newest";
  limit?: number;
};

export type SourceKind = "fixtures" | "live";

export type DataSource = {
  readonly kind: SourceKind;
  /** Human label for the chrome's source badge. */
  readonly label: string;

  workspaces(): Promise<Workspace[]>;
  createWorkspace(name: string, path: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  reorderWorkspaces(ids: string[]): Promise<void>;

  sessions(workspaceId: string): Promise<Session[]>;
  projectFiles(cwd: string): Promise<ProjectFile[]>;
  routines(): Promise<Routine[]>;

  thread(sessionId: string): ThreadHandle;

  createSession(workspaceId: string, kind: SessionKind, draft: SessionDraft): Promise<Session>;
  updateSession(id: string, draft: SessionDraft): Promise<void>;
  renameSession(id: string, name: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  reorderSessions(ids: string[]): Promise<void>;

  search(input: SearchInput): Promise<SearchHit[]>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;

  /** A terminal's scrollback. Live sources stream; fixtures answer once. */
  terminal(sessionId: string): Promise<TerminalLine[]>;

  /** Fires when any session's status changes, so the sidebar can repaint. */
  onSessionStatus(listener: (id: string, status: SessionStatus) => void): () => void;

  /** Live only: whether the socket is up right now. */
  connected?(): boolean;
  onConnectionChange?(listener: (connected: boolean) => void): () => void;

  dispose?(): void;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import { MockSession, sessionRuntime } from "./runtime";
import { searchMessages } from "./search";
import { projectFiles as allFiles, sessions as allSessions, workspaces as allWorkspaces } from "./data/workspace";
import { routines as allRoutines } from "./data/routines";
import { terminalBuffers } from "./data/terminal";
import { contentsOf } from "./data/files";
import { threadFor } from "./data/threads";

/** Fixture calls resolve on a macrotask, so loading states are real. */
const tick = <T,>(value: T, ms = 0): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

export function fixtureSource(): DataSource {
  const statusListeners = new Set<(id: string, status: SessionStatus) => void>();
  const live = new Map<string, MockSession>();
  const written = new Map<string, string>();
  let extra: Session[] = [];
  let newWorkspaces: Workspace[] = [];

  const handleFor = (sessionId: string): ThreadHandle => {
    const session = sessionRuntime(sessionId);
    live.set(sessionId, session);
    let lastStatus = session.snapshot.status;
    session.subscribe((state) => {
      if (state.status === lastStatus) return;
      lastStatus = state.status;
      for (const listener of statusListeners) listener(sessionId, state.status);
    });
    return {
      subscribe: (listener) => session.subscribe(listener),
      snapshot: () => session.snapshot,
      send: (text, files) => session.send(text, files),
      stop: () => session.stop(),
      approve: (requestId, decision) => session.approve(requestId, decision),
      answer: (requestId, answers) => session.answer(requestId, answers),
    };
  };

  return {
    kind: "fixtures",
    label: "Fixtures",
    workspaces: () => tick([...allWorkspaces, ...newWorkspaces]),
    createWorkspace: async (name, path) => {
      const workspace: Workspace = { id: `ws-${Date.now()}`, name, path, createdAt: Date.now() };
      newWorkspaces = [...newWorkspaces, workspace];
      return tick(workspace, 120);
    },
    renameWorkspace: async (id, name) => {
      newWorkspaces = newWorkspaces.map((w) => (w.id === id ? { ...w, name } : w));
      await tick(null, 40);
    },
    deleteWorkspace: async (id) => {
      newWorkspaces = newWorkspaces.filter((w) => w.id !== id);
      await tick(null, 40);
    },
    reorderWorkspaces: async () => tick(undefined),
    sessions: (workspaceId) =>
      tick([...allSessions, ...extra].filter((s) => s.workspaceId === workspaceId)),
    projectFiles: () => tick(allFiles),
    routines: () => tick(allRoutines),
    thread: handleFor,
    createSession: async (workspaceId, kind, draft) => {
      const session: Session = {
        id: `new-${Date.now()}`,
        workspaceId,
        kind,
        name: draft.name,
        provider: draft.provider,
        model: draft.model,
        providerSessionId: null,
        description: draft.description,
        notifications: draft.notifications ?? true,
        autonomy: draft.autonomy,
        status: "idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: null,
      };
      extra = [...extra, session];
      return tick(session, 120);
    },
    updateSession: async (id, draft) => {
      extra = extra.map((s) => (s.id === id ? { ...s, ...draft, updatedAt: Date.now() } : s));
      await tick(null, 120);
    },
    renameSession: async (id, name) => {
      extra = extra.map((s) => (s.id === id ? { ...s, name } : s));
      await tick(null, 40);
    },
    deleteSession: async (id) => {
      extra = extra.filter((s) => s.id !== id);
      await tick(null, 40);
    },
    reorderSessions: async () => tick(undefined),
    search: (input) => tick(searchMessages(input)),
    readTextFile: (path) => {
      const relative = path.replace(/^.*?\/crew\//, "");
      return tick(written.get(relative) ?? contentsOf(relative), 80);
    },
    writeTextFile: async (path, contents) => {
      written.set(path.replace(/^.*?\/crew\//, ""), contents);
      await tick(null, 120);
    },
    terminal: (sessionId) => tick(terminalBuffers[sessionId] ?? []),
    onSessionStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    dispose: () => {
      for (const session of live.values()) session.dispose();
      live.clear();
      statusListeners.clear();
    },
  };
}

/** How many blocks a fixture thread holds, without building a handle. */
export const fixtureThreadSize = (sessionId: string): number => threadFor(sessionId).length;

// ---------------------------------------------------------------------------
// Stress
// ---------------------------------------------------------------------------

import { STRESS_PRESETS, stressWorld, type StressPreset } from "./data/stress";
import { hugeTerminal } from "./data/stress";

/**
 * The fixtures, replaced by a workspace of the given size.
 *
 * Threads it does not hold fall back to the demo transcripts, so every route in
 * the brief still resolves under stress — `#/session/s-harness` with a 400-row
 * sidebar is as interesting a measurement as a 5000-block thread.
 */
export function stressSource(preset: StressPreset = "heavy"): DataSource {
  const world = stressWorld(preset);
  const base = fixtureSource();
  const runtimes = new Map<string, MockSession>();

  return {
    ...base,
    kind: "fixtures",
    label: `Stress · ${preset}`,
    workspaces: () => tick([...world.workspaces, ...allWorkspaces]),
    sessions: (workspaceId) =>
      tick(
        workspaceId === allWorkspaces[0]?.id
          ? [...world.sessions.map((s) => ({ ...s, workspaceId })), ...allSessions.filter((s) => s.workspaceId === workspaceId)]
          : world.sessions.filter((s) => s.workspaceId === workspaceId),
      ),
    projectFiles: () => tick(world.files),
    thread(sessionId) {
      const blocks = world.threads[sessionId];
      if (!blocks) return base.thread(sessionId);
      let held = runtimes.get(sessionId);
      if (!held) {
        held = new MockSession(sessionId, blocks, "idle");
        runtimes.set(sessionId, held);
      }
      const session = held;
      return {
        subscribe: (listener) => session.subscribe(listener),
        snapshot: () => session.snapshot,
        send: (text, files) => session.send(text, files),
        stop: () => session.stop(),
        approve: (requestId, decision) => session.approve(requestId, decision),
        answer: (requestId, answers) => session.answer(requestId, answers),
      };
    },
    // Fifty thousand lines, so a terminal surface has to virtualise or admit it.
    terminal: () => tick(hugeTerminal(50_000)),
    dispose() {
      for (const session of runtimes.values()) session.dispose();
      runtimes.clear();
      base.dispose?.();
    },
  };
}

/**
 * The source a URL asks for. One call, so all three prototypes read the same
 * switches and the tools can drive any of them.
 *
 *   ?source=live        a real crewd through the dev-server plugin
 *   ?stress=heavy       the big fixtures — light | medium | heavy | absurd
 *   (neither)           the demo fixtures
 */
export function sourceFromLocation(
  search: string = typeof location === "undefined" ? "" : location.search,
  makeLive?: () => DataSource,
): DataSource {
  const params = new URLSearchParams(search);
  if (params.get("source") === "live" && makeLive) return makeLive();
  const preset = params.get("stress");
  if (preset && preset in STRESS_PRESETS) return stressSource(preset as StressPreset);
  return fixtureSource();
}
