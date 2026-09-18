import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  COMMANDS,
  activeWorkspaceId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  type Chord,
  type CommandId,
  type ProjectFile,
  type Routine,
  type Session,
  type SessionKind,
  type SessionStatus,
  type SettingsSectionId,
  type StubKind,
  type Tab,
  type Workspace,
} from "@crew/fixtures";
import { loadPref, savePref } from "./prefs";
import { parseRoute, formatRoute, type Route } from "./route";
import { source } from "./source";
import {
  NO_TABS,
  closeTab,
  fileTabId,
  moveTab,
  openTab,
  reopenTab,
  sessionTabId,
  stepTab,
  stubTabId,
  type TabState,
} from "./tabs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Grouping = "none" | "kind" | "provider" | "status";
export type Ordering = "manual" | "updated" | "name";
export type ThemeChoice = "light" | "dark" | "system";
export type AgentTheme = "generated" | "provider" | "mono";

export type SidebarPrefs = {
  grouping: Grouping;
  ordering: Ordering;
  show: { provider: boolean; updated: boolean; status: boolean; avatar: boolean };
  hideKinds: SessionKind[];
  hideProviders: string[];
};

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  grouping: "kind",
  ordering: "updated",
  show: { provider: true, updated: true, status: true, avatar: true },
  hideKinds: [],
  hideProviders: [],
};

export type Page =
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines" }
  | { kind: "routine"; id: string }
  | { kind: "search"; query: string }
  | { kind: "agents" }
  | null;

export type Drawer =
  | { kind: "agent-thread"; sessionId: string; peerId: string }
  | { kind: "agent-sheet"; mode: "create" | "edit"; sessionId?: string }
  | { kind: "diff"; path: string }
  | null;

export type PaletteFilter = "all" | "agents" | "sessions" | "files" | "actions";

export type ConfirmRequest = {
  title: string;
  description: string;
  actionLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
};

export type TerminalPrefs = { fontFamily: string; fontSize: number; cursor: "block" | "bar" | "underline" };

export type Reveal = { sessionId: string; blockId: string; nonce: number } | null;

export type Toast = { id: number; text: string };

// ---------------------------------------------------------------------------

const DEFAULT_TAB_SESSIONS = ["s-harness", "s-relay", "s-daemon", "t-build"];
const DEFAULT_TAB_FILE = "src/lib/tabs.ts";

export type Store = ReturnType<typeof useStoreValue>;

const StoreContext = createContext<Store | null>(null);

/** Theme only. Avatars read this so they do not repaint on unrelated state. */
const LookContext = createContext<{ dark: boolean; agentTheme: AgentTheme }>({
  dark: false,
  agentTheme: "generated",
});

export function useStore(): Store {
  const found = useContext(StoreContext);
  if (!found) throw new Error("useStore outside StoreProvider");
  return found;
}

export const useLook = () => useContext(LookContext);

function useStoreValue() {
  // --- theme ---------------------------------------------------------------
  const [theme, setThemeState] = useState<ThemeChoice>(() => loadPref("theme", "system" as ThemeChoice));
  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const dark = theme === "system" ? systemDark : theme === "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    savePref("theme", next);
  }, []);
  const toggleTheme = useCallback(() => setTheme(dark ? "light" : "dark"), [dark, setTheme]);
  const [agentTheme, setAgentThemeState] = useState<AgentTheme>(() =>
    loadPref("agentTheme", "generated" as AgentTheme),
  );
  const setAgentTheme = useCallback((next: AgentTheme) => {
    setAgentThemeState(next);
    savePref("agentTheme", next);
  }, []);

  // --- data ----------------------------------------------------------------
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [connected, setConnected] = useState(source.connected?.() ?? true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void source.workspaces().then((list) => {
      if (!alive) return;
      setWorkspaces(list);
      setWorkspaceId((held) => {
        if (held && list.some((w) => w.id === held)) return held;
        // The stress world prepends forty generated workspaces but hangs its
        // four hundred sessions off the demo one, so "the first workspace" is
        // the wrong default.
        const preferred = list.find((w) => w.id === activeWorkspaceId);
        return preferred?.id ?? list[0]?.id ?? "";
      });
    });
    void source.routines().then((list) => alive && setRoutines(list));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setLoading(true);
    void source.sessions(workspaceId).then((list) => {
      if (!alive) return;
      setSessions(list);
      setStatuses((held) => {
        const next = { ...held };
        for (const session of list) if (next[session.id] === undefined) next[session.id] = session.status;
        return next;
      });
      setLoading(false);
    });
    const workspace = workspaces.find((w) => w.id === workspaceId);
    void source.projectFiles(workspace?.path ?? "").then((list) => alive && setFiles(list));
    return () => {
      alive = false;
    };
  }, [workspaceId, workspaces]);

  useEffect(() => source.onSessionStatus((id, status) => {
    setStatuses((held) => (held[id] === status ? held : { ...held, [id]: status }));
  }), []);

  useEffect(() => source.onConnectionChange?.(setConnected), []);

  const statusOf = useCallback((id: string): SessionStatus => statuses[id] ?? "idle", [statuses]);
  const setStatus = useCallback((id: string, status: SessionStatus) => {
    setStatuses((held) => ({ ...held, [id]: status }));
  }, []);

  const sessionById = useCallback(
    (id: string): Session | undefined => sessions.find((s) => s.id === id),
    [sessions],
  );
  const wsSessions = sessions;

  // --- tabs ----------------------------------------------------------------
  const [tabsByWs, setTabsByWs] = useState<Record<string, TabState>>({});
  const tabState = tabsByWs[workspaceId] ?? NO_TABS;
  const patchTabs = useCallback(
    (fn: (state: TabState) => TabState) => {
      setTabsByWs((held) => ({ ...held, [workspaceId]: fn(held[workspaceId] ?? NO_TABS) }));
    },
    [workspaceId],
  );

  // A first workspace with no tabs opens the demo set that exists in it.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !workspaceId || sessions.length === 0) return;
    seeded.current = true;
    const tabs: Tab[] = DEFAULT_TAB_SESSIONS.filter((id) => sessions.some((s) => s.id === id)).map(
      (sessionId) => ({ id: sessionTabId(sessionId), kind: "session", sessionId }),
    );
    if (tabs.length === 0) {
      const first = sessions[0];
      if (first) tabs.push({ id: sessionTabId(first.id), kind: "session", sessionId: first.id });
    }
    tabs.push({
      id: fileTabId(DEFAULT_TAB_FILE),
      kind: "file",
      path: `/Users/you/crew/${DEFAULT_TAB_FILE}`,
      relative: DEFAULT_TAB_FILE,
    });
    setTabsByWs((held) => {
      const current = held[workspaceId];
      if (current && current.tabs.length > 0) return held;
      return { ...held, [workspaceId]: { tabs, activeId: tabs[0]?.id ?? null, closed: [] } };
    });
  }, [workspaceId, sessions]);

  // --- pages, drawer, overlays --------------------------------------------
  const [page, setPageState] = useState<Page>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [palette, setPalette] = useState<PaletteFilter | null>(null);
  const [launcher, setLauncher] = useState(false);
  const [wsPicker, setWsPicker] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [reveal, setReveal] = useState<Reveal>(null);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((held) => [...held, { id, text }]);
    window.setTimeout(() => setToasts((held) => held.filter((t) => t.id !== id)), 2600);
  }, []);

  const setPage = useCallback((next: Page) => setPageState(next), []);

  const activateTab = useCallback(
    (id: string) => {
      setPageState(null);
      patchTabs((state) => ({ ...state, activeId: id }));
    },
    [patchTabs],
  );

  const openTabHere = useCallback(
    (tab: Tab) => {
      setPageState(null);
      patchTabs((state) => openTab(state, tab));
    },
    [patchTabs],
  );

  const openSession = useCallback(
    (sessionId: string) => openTabHere({ id: sessionTabId(sessionId), kind: "session", sessionId }),
    [openTabHere],
  );

  const openFile = useCallback(
    (relative: string) =>
      openTabHere({
        id: fileTabId(relative),
        kind: "file",
        path: `/Users/you/crew/${relative}`,
        relative,
      }),
    [openTabHere],
  );

  const openStub = useCallback(
    (stub: StubKind, title: string) => openTabHere({ id: stubTabId(stub), kind: "stub", stub, title }),
    [openTabHere],
  );

  const activeTab = tabState.tabs.find((t) => t.id === tabState.activeId) ?? null;

  const doCloseTab = useCallback((id: string) => patchTabs((state) => closeTab(state, id)), [patchTabs]);

  /** A live session gets a confirm; everything else closes straight away. */
  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabState.tabs.find((t) => t.id === id);
      const live =
        tab?.kind === "session" &&
        (statusOf(tab.sessionId) === "working" || statusOf(tab.sessionId) === "needs-input");
      if (!live || !tab || tab.kind !== "session") {
        doCloseTab(id);
        return;
      }
      const name = sessionById(tab.sessionId)?.name ?? "this session";
      setConfirmRequest({
        title: `Close ${name}?`,
        description: "The session is still running. Closing the tab leaves it running in the background.",
        actionLabel: "Close tab",
        onConfirm: () => doCloseTab(id),
      });
    },
    [doCloseTab, sessionById, statusOf, tabState.tabs],
  );

  // --- sidebar -------------------------------------------------------------
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadPref("sidebar:collapsed", false));
  const [sidebarWidth, setSidebarWidthState] = useState(() => loadPref("sidebar:width", 264));
  const [sidebarView, setSidebarView] = useState<"sessions" | "settings">("sessions");
  const [prefs, setPrefsState] = useState<SidebarPrefs>(() => loadPref("sidebar:prefs", DEFAULT_SIDEBAR_PREFS));
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);

  useEffect(() => {
    setManualOrder((held) => (held.length === 0 ? sessions.map((s) => s.id) : held));
  }, [sessions]);

  const setSidebarWidth = useCallback((width: number) => {
    const clamped = Math.min(560, Math.max(200, Math.round(width)));
    setSidebarWidthState(clamped);
    savePref("sidebar:width", clamped);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((held) => {
      savePref("sidebar:collapsed", !held);
      return !held;
    });
  }, []);

  const setPrefs = useCallback((next: SidebarPrefs) => {
    setPrefsState(next);
    savePref("sidebar:prefs", next);
  }, []);

  // A multi-selection is held against the active tab and dropped when it changes.
  useEffect(() => {
    setSelection([]);
  }, [tabState.activeId]);

  // --- terminal / keys -----------------------------------------------------
  const [terminalPrefs, setTerminalPrefsState] = useState<TerminalPrefs>(() =>
    loadPref("terminal", { fontFamily: "ui-monospace", fontSize: 13, cursor: "block" } as TerminalPrefs),
  );
  const setTerminalPrefs = useCallback((next: TerminalPrefs) => {
    setTerminalPrefsState(next);
    savePref("terminal", next);
  }, []);

  const [chords, setChords] = useState<Partial<Record<CommandId, Chord>>>(() => loadPref("chords", {}));
  const chordFor = useCallback((id: CommandId): Chord => chords[id] ?? COMMANDS[id].keys, [chords]);
  const setChord = useCallback((id: CommandId, chord: Chord | null) => {
    setChords((held) => {
      const next = { ...held };
      if (chord) next[id] = chord;
      else delete next[id];
      savePref("chords", next);
      return next;
    });
  }, []);

  // --- files ---------------------------------------------------------------
  const [fileCache, setFileCache] = useState<Record<string, string>>({});
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});
  const pending = useRef(new Set<string>());

  const loadFile = useCallback((relative: string) => {
    if (pending.current.has(relative)) return;
    pending.current.add(relative);
    void source.readTextFile(`/Users/you/crew/${relative}`).then((text) => {
      setFileCache((held) => ({ ...held, [relative]: text }));
    });
  }, []);

  const editFile = useCallback((relative: string, text: string) => {
    setFileEdits((held) => ({ ...held, [relative]: text }));
  }, []);

  const saveFile = useCallback(
    (relative: string) => {
      setFileEdits((held) => {
        const text = held[relative];
        if (text === undefined) return held;
        setFileCache((cache) => ({ ...cache, [relative]: text }));
        void source.writeTextFile(`/Users/you/crew/${relative}`, text);
        const next = { ...held };
        delete next[relative];
        return next;
      });
      toast(`Saved ${relative}`);
    },
    [toast],
  );

  // --- routines ------------------------------------------------------------
  const updateRoutine = useCallback((id: string, patch: Partial<Routine>) => {
    setRoutines((held) => held.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);
  const createRoutine = useCallback((): string => {
    const id = `r-new-${Date.now()}`;
    setRoutines((held) => [
      {
        id,
        sessionId: sessions.find((s) => s.kind === "agent")?.id ?? "",
        name: "New routine",
        enabled: true,
        prompt: "",
        schedule: { kind: "interval", minutes: 60 },
        lastRunAt: null,
        nextRunAt: Date.now() + 3_600_000,
        runs: [],
        createdBy: null,
      },
      ...held,
    ]);
    return id;
  }, [sessions]);
  const deleteRoutine = useCallback((id: string) => {
    setRoutines((held) => held.filter((r) => r.id !== id));
  }, []);
  const runRoutine = useCallback(
    (id: string) => {
      const at = Date.now();
      setRoutines((held) =>
        held.map((r) =>
          r.id === id
            ? {
                ...r,
                lastRunAt: at,
                runs: [
                  { id: `run-${at}`, startedAt: at, finishedAt: null, status: "running", trigger: "manual" },
                  ...r.runs,
                ],
              }
            : r,
        ),
      );
      window.setTimeout(() => {
        setRoutines((held) =>
          held.map((r) =>
            r.id === id
              ? {
                  ...r,
                  runs: r.runs.map((run) =>
                    run.startedAt === at ? { ...run, status: "ok", finishedAt: Date.now() } : run,
                  ),
                }
              : r,
          ),
        );
      }, 2400);
      toast("Routine started");
    },
    [toast],
  );

  // --- session CRUD --------------------------------------------------------
  const createSession = useCallback(
    (input: Partial<Session> & { name: string }): Session => {
      const optimistic: Session = {
        id: `pending-${Date.now()}`,
        workspaceId,
        kind: input.kind ?? "agent",
        name: input.name,
        provider: input.provider ?? DEFAULT_PROVIDER,
        model: input.model ?? DEFAULT_MODEL,
        providerSessionId: null,
        description: input.description ?? "",
        notifications: input.notifications ?? true,
        autonomy: input.autonomy ?? "ask",
        status: "idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: input.createdBy ?? null,
      };
      setSessions((held) => [...held, optimistic]);
      void source
        .createSession(workspaceId, optimistic.kind, {
          name: optimistic.name,
          provider: optimistic.provider,
          model: optimistic.model,
          description: optimistic.description,
          autonomy: optimistic.autonomy,
          notifications: optimistic.notifications,
        })
        .then((created) => {
          setSessions((held) => held.map((s) => (s.id === optimistic.id ? created : s)));
          setStatuses((held) => ({ ...held, [created.id]: created.status }));
          patchTabs((state) => {
            const at = state.tabs.findIndex((t) => t.id === sessionTabId(optimistic.id));
            if (at < 0) return state;
            const tabs = state.tabs.slice();
            tabs[at] = { id: sessionTabId(created.id), kind: "session", sessionId: created.id };
            return { ...state, tabs, activeId: tabs[at]!.id };
          });
        });
      return optimistic;
    },
    [workspaceId, patchTabs],
  );

  const updateSession = useCallback((id: string, patch: Partial<Session>) => {
    setSessions((held) =>
      held.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, ...patch, updatedAt: Date.now() };
        void source.updateSession(id, {
          name: next.name,
          provider: next.provider,
          model: next.model,
          description: next.description,
          autonomy: next.autonomy,
          notifications: next.notifications,
        });
        return next;
      }),
    );
  }, []);

  const deleteSessions = useCallback(
    (ids: string[]) => {
      setSessions((held) => held.filter((s) => !ids.includes(s.id)));
      setSelection([]);
      for (const id of ids) void source.deleteSession(id);
      patchTabs((state) => ids.reduce((acc, id) => closeTab(acc, sessionTabId(id)), state));
    },
    [patchTabs],
  );

  // --- workspace CRUD ------------------------------------------------------
  const createWorkspace = useCallback((name: string, path: string) => {
    void source.createWorkspace(name, path).then((workspace) => {
      setWorkspaces((held) => [...held, workspace]);
      setWorkspaceId(workspace.id);
    });
  }, []);
  const renameWorkspace = useCallback((id: string, name: string) => {
    setWorkspaces((held) => held.map((w) => (w.id === id ? { ...w, name } : w)));
    void source.renameWorkspace(id, name);
  }, []);
  const deleteWorkspace = useCallback((id: string) => {
    void source.deleteWorkspace(id);
    setWorkspaces((held) => {
      const next = held.filter((w) => w.id !== id);
      setWorkspaceId((current) => (current === id ? (next[0]?.id ?? "") : current));
      return next;
    });
  }, []);
  const moveWorkspace = useCallback((from: number, to: number) => {
    setWorkspaces((held) => {
      if (from === to || to < 0 || to >= held.length) return held;
      const next = held.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) return held;
      next.splice(to, 0, moved);
      void source.reorderWorkspaces(next.map((w) => w.id));
      return next;
    });
  }, []);
  const stepWorkspace = useCallback(
    (delta: number) => {
      setWorkspaceId((current) => {
        const index = workspaces.findIndex((w) => w.id === current);
        const next = (((index + delta) % workspaces.length) + workspaces.length) % workspaces.length;
        return workspaces[next]?.id ?? current;
      });
    },
    [workspaces],
  );

  const revealBlock = useCallback(
    (sessionId: string, blockId: string) => {
      openSession(sessionId);
      setReveal({ sessionId, blockId, nonce: Date.now() });
    },
    [openSession],
  );

  // --- hash route ----------------------------------------------------------
  const booted = useRef(false);
  const known = useRef<{ sessions: Session[]; routines: Routine[] }>({ sessions: [], routines: [] });
  known.current = { sessions, routines };

  const applyRoute = useCallback(
    (route: Route) => {
      switch (route.kind) {
        case "session": {
          setPageState(null);
          setTabsByWs((held) => ({
            ...held,
            [workspaceId]: openTab(held[workspaceId] ?? NO_TABS, {
              id: sessionTabId(route.id),
              kind: "session",
              sessionId: route.id,
            }),
          }));
          return;
        }
        case "file":
          setPageState(null);
          setTabsByWs((held) => ({
            ...held,
            [workspaceId]: openTab(held[workspaceId] ?? NO_TABS, {
              id: fileTabId(route.path),
              kind: "file",
              path: `/Users/you/crew/${route.path}`,
              relative: route.path,
            }),
          }));
          return;
        case "search":
          setPageState({ kind: "search", query: "" });
          return;
        case "routines":
          setPageState({ kind: "routines" });
          return;
        case "routine":
          setPageState({ kind: "routine", id: route.id });
          return;
        case "settings":
          setPageState({ kind: "settings", section: route.section });
          return;
        case "agents":
          setPageState({ kind: "agents" });
          return;
        case "default":
          setPageState(null);
      }
    },
    [workspaceId],
  );

  // Boot once the first workspace is known, so a `#/session/...` route lands in
  // a tab strip that exists.
  useEffect(() => {
    if (booted.current || !workspaceId) return;
    booted.current = true;
    applyRoute(parseRoute(location.hash));
    const onHash = () => applyRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [workspaceId, applyRoute]);

  const route: Route = useMemo(() => {
    if (page) {
      switch (page.kind) {
        case "settings":
          return { kind: "settings", section: page.section };
        case "routines":
          return { kind: "routines" };
        case "routine":
          return { kind: "routine", id: page.id };
        case "search":
          return { kind: "search" };
        case "agents":
          return { kind: "agents" };
      }
    }
    if (activeTab?.kind === "session") return { kind: "session", id: activeTab.sessionId };
    if (activeTab?.kind === "file") return { kind: "file", path: activeTab.relative };
    return { kind: "default" };
  }, [page, activeTab]);

  useEffect(() => {
    if (!booted.current) return;
    const next = `${location.pathname}${location.search}${formatRoute(route)}`;
    if (location.hash !== formatRoute(route)) history.replaceState(null, "", next);
  }, [route]);

  return {
    theme,
    setTheme,
    dark,
    toggleTheme,
    agentTheme,
    setAgentTheme,

    sourceKind: source.kind,
    sourceLabel: source.label,
    connected,
    loading,

    workspaces,
    workspaceId,
    setWorkspaceId,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveWorkspace,
    stepWorkspace,

    sessions,
    wsSessions,
    sessionById,
    createSession,
    updateSession,
    deleteSessions,
    statusOf,
    setStatus,
    files,

    tabState,
    activeTab,
    openSession,
    openFile,
    openStub,
    activateTab,
    requestCloseTab,
    closeTabNow: doCloseTab,
    stepTabs: useCallback((delta: number) => patchTabs((s) => stepTab(s, delta)), [patchTabs]),
    gotoTab: useCallback(
      (index: number) =>
        patchTabs((s) => {
          const tab = index === -1 ? s.tabs.at(-1) : s.tabs[index];
          return tab ? { ...s, activeId: tab.id } : s;
        }),
      [patchTabs],
    ),
    reopenClosed: useCallback(() => patchTabs(reopenTab), [patchTabs]),
    moveTabTo: useCallback((from: number, to: number) => patchTabs((s) => moveTab(s, from, to)), [patchTabs]),

    page,
    setPage,
    drawer,
    setDrawer,
    palette,
    setPalette,
    launcher,
    setLauncher,
    wsPicker,
    setWsPicker,
    confirmRequest,
    setConfirmRequest,
    toasts,
    toast,
    reveal,
    setReveal,
    revealBlock,

    sidebarCollapsed,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
    sidebarView,
    setSidebarView,
    prefs,
    setPrefs,
    query,
    setQuery,
    selection,
    setSelection,
    manualOrder,
    setManualOrder,
    collapsedGroups,
    setCollapsedGroups,

    terminalPrefs,
    setTerminalPrefs,
    chordFor,
    chords,
    setChord,

    fileCache,
    fileEdits,
    loadFile,
    editFile,
    saveFile,

    routines,
    updateRoutine,
    createRoutine,
    deleteRoutine,
    runRoutine,
  };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreValue();
  const look = useMemo(
    () => ({ dark: value.dark, agentTheme: value.agentTheme }),
    [value.dark, value.agentTheme],
  );
  return (
    <LookContext.Provider value={look}>
      <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
    </LookContext.Provider>
  );
}
