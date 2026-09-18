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
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  activeWorkspaceId as PREFERRED_WORKSPACE,
  SETTINGS_SECTIONS,
} from "@crew/fixtures";
import type {
  ProjectFile,
  Routine,
  Session,
  SessionStatus,
  SettingsSectionId,
  StubKind,
  Tab,
  Workspace,
} from "@crew/fixtures";
import { DEFAULT_PREFS, type SidebarPrefs } from "./sidebar";
import { readPref, writePref } from "./store-prefs";
import {
  NO_TABS,
  closeTab,
  moveTab,
  openTab,
  reopenTab,
  stepTab,
  stubTabId,
  tabForFile,
  tabForSession,
  type TabState,
} from "./tabs";
import { formatRoute, parseHash, writeHash, type Route } from "./hash";
import { SOURCE, threadOf } from "./source";

export type ThemePref = "light" | "dark" | "system";
export type PaletteFilter = "all" | "agents" | "sessions" | "files" | "actions";
export type SidebarView = "sessions" | "settings";

export type Page =
  | null
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; routineId: string | null }
  | { kind: "search" };

export type ConfirmSpec = {
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
};

export type TerminalPrefs = {
  fontFamily: string;
  fontSize: number;
  cursorStyle: "block" | "bar" | "underline";
};

export type FocusRequest = { sessionId: string; blockId: string; token: number };

export type AppState = {
  theme: ThemePref;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  sessions: Session[];
  tabsByWorkspace: Record<string, TabState>;
  page: Page;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  sidebarView: SidebarView;
  prefs: SidebarPrefs;
  manualOrder: string[];
  query: string;
  selection: string[];
  selectionTabId: string | null;
  routines: Routine[];
  terminal: TerminalPrefs;
  agentTheme: string;
  palette: { open: boolean; filter: PaletteFilter; seed: string };
  sheet: { open: boolean; sessionId: string | null };
  confirm: ConfirmSpec | null;
  launcher: boolean;
  workspacePicker: boolean;
  focus: FocusRequest | null;
  /** Everything the data source answered with. Empty until it has. */
  files: ProjectFile[];
  ready: boolean;
  connected: boolean;
  searchSeed: { query: string; token: number };
  keymap: Record<string, string>;
};

/**
 * The tabs a fresh window opens, when the source happens to hold them. Live and
 * stress workspaces have neither, and open with whatever the route asks for.
 */
const SEEDED_TABS = ["s-harness", "s-relay", "s-daemon", "t-build"];
const SEEDED_FILE = "src/lib/tabs.ts";

function seedTabs(sessions: Session[], files: ProjectFile[]): TabState {
  const tabs: Tab[] = [];
  for (const id of SEEDED_TABS) {
    const session = sessions.find((s) => s.id === id);
    if (session) tabs.push(tabForSession(session));
  }
  const file = files.find((f) => f.relative === SEEDED_FILE);
  if (file) tabs.push(tabForFile(file.relative, file.path));
  return { tabs, activeId: tabs[0]?.id ?? null, closed: [] };
}

function initialState(): AppState {
  return {
    theme: readPref<ThemePref>("theme", "system"),
    workspaces: [],
    activeWorkspaceId: "",
    sessions: [],
    files: [],
    ready: false,
    connected: SOURCE.connected?.() ?? true,
    tabsByWorkspace: {},
    page: null,
    sidebarCollapsed: readPref("sidebar.collapsed", false),
    sidebarWidth: readPref("sidebar.width", 268),
    sidebarView: "sessions",
    prefs: { ...DEFAULT_PREFS, ...readPref<Partial<SidebarPrefs>>("sidebar.prefs", {}) },
    manualOrder: readPref<string[]>("sidebar.order", []),
    query: "",
    selection: [],
    selectionTabId: null,
    routines: [],
    terminal: readPref<TerminalPrefs>("terminal", {
      fontFamily: "JetBrains Mono",
      fontSize: 12,
      cursorStyle: "block",
    }),
    agentTheme: readPref("agentTheme", "ink"),
    palette: { open: false, filter: "all", seed: "" },
    sheet: { open: false, sessionId: null },
    confirm: null,
    launcher: false,
    workspacePicker: false,
    focus: null,
    searchSeed: { query: "", token: 0 },
    keymap: readPref<Record<string, string>>("keymap", {}),
  };
}

type Ctx = AppState & {
  set: (next: Partial<AppState> | ((prev: AppState) => Partial<AppState>)) => void;
  tabs: TabState;
  activeTab: Tab | null;
  workspace: Workspace;
  actions: Actions;
};

/** Stands in for the active workspace until the source has answered. */
const NO_WORKSPACE: Workspace = { id: "", name: "—", path: "", createdAt: 0 };

const AppContext = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

export type Actions = ReturnType<typeof buildActions>;

function buildActions(
  get: () => AppState,
  set: (next: Partial<AppState> | ((prev: AppState) => Partial<AppState>)) => void,
) {
  const tabsOf = (state: AppState) => state.tabsByWorkspace[state.activeWorkspaceId] ?? NO_TABS;

  const withTabs = (fn: (tabs: TabState, state: AppState) => TabState) =>
    set((state) => {
      const next = fn(tabsOf(state), state);
      const changedActive = next.activeId !== tabsOf(state).activeId;
      return {
        tabsByWorkspace: { ...state.tabsByWorkspace, [state.activeWorkspaceId]: next },
        page: null,
        ...(changedActive ? { selection: [], selectionTabId: next.activeId } : {}),
      };
    });

  const actions = {
    setTheme(theme: ThemePref) {
      writePref("theme", theme);
      set({ theme });
    },
    toggleTheme() {
      const state = get();
      const resolved =
        state.theme === "system"
          ? document.documentElement.dataset.theme === "dark"
            ? "dark"
            : "light"
          : state.theme;
      const next: ThemePref = resolved === "dark" ? "light" : "dark";
      writePref("theme", next);
      set({ theme: next });
    },

    // -- shell ------------------------------------------------------------
    toggleSidebar() {
      set((state) => {
        writePref("sidebar.collapsed", !state.sidebarCollapsed);
        return { sidebarCollapsed: !state.sidebarCollapsed };
      });
    },
    setSidebarWidth(width: number) {
      const clamped = Math.max(200, Math.min(560, Math.round(width)));
      writePref("sidebar.width", clamped);
      set({ sidebarWidth: clamped });
    },
    setSidebarView(sidebarView: SidebarView) {
      set({ sidebarView });
    },

    // -- pages ------------------------------------------------------------
    openSettings(section: SettingsSectionId = "general") {
      set({ page: { kind: "settings", section }, sidebarView: "settings", launcher: false });
    },
    openRoutines(routineId: string | null = null) {
      set({ page: { kind: "routines", routineId }, launcher: false });
    },
    openSearch(query?: string) {
      set((state) => ({
        page: { kind: "search" },
        launcher: false,
        searchSeed:
          query === undefined
            ? state.searchSeed
            : { query, token: state.searchSeed.token + 1 },
      }));
    },
    closePage() {
      set({ page: null, sidebarView: "sessions" });
    },

    // -- workspaces -------------------------------------------------------
    setWorkspace(id: string) {
      set((state) =>
        state.workspaces.some((w) => w.id === id)
          ? { activeWorkspaceId: id, page: null, selection: [] }
          : {},
      );
    },
    stepWorkspace(delta: number) {
      set((state) => {
        const index = state.workspaces.findIndex((w) => w.id === state.activeWorkspaceId);
        const count = state.workspaces.length;
        const next = (((index + delta) % count) + count) % count;
        return { activeWorkspaceId: state.workspaces[next]!.id, page: null, selection: [] };
      });
    },
    workspaceAt(index: number) {
      set((state) => {
        const target = state.workspaces[index];
        return target ? { activeWorkspaceId: target.id, page: null, selection: [] } : {};
      });
    },
    async createWorkspace(name: string, path: string) {
      const workspace = await SOURCE.createWorkspace(name, path);
      set((state) => ({
        workspaces: [...state.workspaces, workspace],
        tabsByWorkspace: { ...state.tabsByWorkspace, [workspace.id]: NO_TABS },
        activeWorkspaceId: workspace.id,
        page: null,
      }));
    },
    renameWorkspace(id: string, name: string) {
      void SOURCE.renameWorkspace(id, name);
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
      }));
    },
    deleteWorkspace(id: string) {
      void SOURCE.deleteWorkspace(id);
      set((state) => {
        if (state.workspaces.length <= 1) return {};
        const workspaces = state.workspaces.filter((w) => w.id !== id);
        return {
          workspaces,
          activeWorkspaceId:
            state.activeWorkspaceId === id ? workspaces[0]!.id : state.activeWorkspaceId,
        };
      });
    },
    reorderWorkspaces(from: number, to: number) {
      set((state) => {
        const workspaces = state.workspaces.slice();
        const [held] = workspaces.splice(from, 1);
        if (held) workspaces.splice(to, 0, held);
        void SOURCE.reorderWorkspaces(workspaces.map((w) => w.id));
        return { workspaces };
      });
    },

    // -- tabs -------------------------------------------------------------
    openSession(sessionId: string) {
      set((state) => {
        const session = state.sessions.find((s) => s.id === sessionId);
        if (!session) return {};
        const workspaceId = session.workspaceId;
        const tabs = state.tabsByWorkspace[workspaceId] ?? NO_TABS;
        const next = openTab(tabs, tabForSession(session));
        return {
          activeWorkspaceId: workspaceId,
          tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: next },
          page: null,
          sessions: state.sessions.map((s) =>
            s.id === sessionId && s.status === "done" ? { ...s, status: "idle" } : s,
          ),
          selection: [],
          selectionTabId: next.activeId,
        };
      });
    },
    openFile(relative: string, path?: string) {
      const state = get();
      const known = state.files.find((f) => f.relative === relative);
      const root = state.workspaces.find((w) => w.id === state.activeWorkspaceId)?.path ?? "";
      const resolved = path ?? known?.path ?? `${root}/${relative}`;
      withTabs((tabs) => openTab(tabs, tabForFile(relative, resolved)));
    },
    openStub(stub: StubKind, title: string) {
      withTabs((tabs) => openTab(tabs, { id: stubTabId(stub), kind: "stub", stub, title }));
    },
    activateTab(id: string) {
      withTabs((tabs) => ({ ...tabs, activeId: id }));
    },
    closeTab(id: string) {
      withTabs((tabs) => closeTab(tabs, id));
    },
    closeActiveTab() {
      const state = get();
      const tabs = tabsOf(state);
      if (state.page) {
        set({ page: null, sidebarView: "sessions" });
        return;
      }
      if (tabs.activeId) actions.requestCloseTab(tabs.activeId);
    },
    requestCloseTab(id: string) {
      const state = get();
      const tabs = tabsOf(state);
      const tab = tabs.tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.kind === "session") {
        const session = state.sessions.find((s) => s.id === tab.sessionId);
        const live =
          session &&
          (session.status === "working" ||
            session.status === "needs-input" ||
            threadOf(session.id).snapshot().working);
        if (live) {
          set({
            confirm: {
              title: `Close ${session!.name}?`,
              description: "The session is still running. Closing the tab leaves it running in the background.",
              confirmLabel: "Close tab",
              destructive: true,
              onConfirm: () => withTabs((held) => closeTab(held, id)),
            },
          });
          return;
        }
      }
      withTabs((held) => closeTab(held, id));
    },
    reopenTab() {
      withTabs((tabs) => reopenTab(tabs));
    },
    stepTab(delta: number) {
      withTabs((tabs) => stepTab(tabs, delta));
    },
    tabAt(index: number) {
      withTabs((tabs) => {
        const target = tabs.tabs[index];
        return target ? { ...tabs, activeId: target.id } : tabs;
      });
    },
    lastTab() {
      withTabs((tabs) => {
        const target = tabs.tabs.at(-1);
        return target ? { ...tabs, activeId: target.id } : tabs;
      });
    },
    moveTab(from: number, to: number) {
      set((state) => ({
        tabsByWorkspace: {
          ...state.tabsByWorkspace,
          [state.activeWorkspaceId]: moveTab(tabsOf(state), from, to),
        },
      }));
    },
    setLauncher(launcher: boolean) {
      set({ launcher });
    },
    setWorkspacePicker(workspacePicker: boolean) {
      set({ workspacePicker });
    },

    // -- palette ----------------------------------------------------------
    openPalette(filter: PaletteFilter = "all", seed = "") {
      set({ palette: { open: true, filter, seed } });
    },
    closePalette() {
      set((state) => ({ palette: { ...state.palette, open: false } }));
    },

    // -- sessions ---------------------------------------------------------
    setQuery(query: string) {
      set({ query });
    },
    setPrefs(next: Partial<SidebarPrefs>) {
      set((state) => {
        const prefs = { ...state.prefs, ...next };
        writePref("sidebar.prefs", prefs);
        return { prefs };
      });
    },
    setManualOrder(order: string[]) {
      writePref("sidebar.order", order);
      set({ manualOrder: order });
    },
    select(id: string, mode: "replace" | "toggle" | "range") {
      set((state) => {
        const tabs = tabsOf(state);
        if (mode === "toggle") {
          const has = state.selection.includes(id);
          return {
            selection: has ? state.selection.filter((s) => s !== id) : [...state.selection, id],
            selectionTabId: tabs.activeId,
          };
        }
        if (mode === "range") {
          const anchor = state.selection.at(-1);
          const visible = state.sessions
            .filter((s) => s.workspaceId === state.activeWorkspaceId)
            .map((s) => s.id);
          const from = anchor ? visible.indexOf(anchor) : -1;
          const to = visible.indexOf(id);
          if (from === -1 || to === -1) return { selection: [id], selectionTabId: tabs.activeId };
          const [lo, hi] = from < to ? [from, to] : [to, from];
          return { selection: visible.slice(lo, hi + 1), selectionTabId: tabs.activeId };
        }
        return { selection: [id], selectionTabId: tabs.activeId };
      });
    },
    clearSelection() {
      set({ selection: [] });
    },
    renameSession(id: string, name: string) {
      void SOURCE.renameSession(id, name);
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, name, updatedAt: Date.now() } : s)),
      }));
    },
    updateSession(id: string, patch: Partial<Session>) {
      set((state) => {
        const sessions = state.sessions.map((s) =>
          s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s,
        );
        const next = sessions.find((s) => s.id === id);
        if (next) {
          void SOURCE.updateSession(id, {
            name: next.name,
            provider: next.provider,
            model: next.model,
            description: next.description,
            autonomy: next.autonomy,
            notifications: next.notifications,
          });
        }
        return { sessions };
      });
    },
    setStatus(id: string, status: SessionStatus) {
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, status, updatedAt: Date.now() } : s)),
      }));
    },
    deleteSessions(ids: string[]) {
      for (const id of ids) void SOURCE.deleteSession(id);
      set((state) => {
        const drop = new Set(ids);
        const tabsByWorkspace: Record<string, TabState> = {};
        for (const [key, tabs] of Object.entries(state.tabsByWorkspace)) {
          const kept = tabs.tabs.filter((t) => t.kind !== "session" || !drop.has(t.sessionId));
          tabsByWorkspace[key] = {
            ...tabs,
            tabs: kept,
            activeId: kept.some((t) => t.id === tabs.activeId) ? tabs.activeId : (kept.at(-1)?.id ?? null),
          };
        }
        return {
          sessions: state.sessions.filter((s) => !drop.has(s.id)),
          tabsByWorkspace,
          selection: [],
        };
      });
    },
    async createSession(input: Partial<Session> & { name: string }) {
      const state = get();
      const session = await SOURCE.createSession(state.activeWorkspaceId, input.kind ?? "agent", {
        name: input.name,
        provider: input.provider ?? DEFAULT_PROVIDER,
        model: input.model ?? DEFAULT_MODEL,
        description: input.description ?? "",
        autonomy: input.autonomy ?? "ask",
        ...(input.notifications !== undefined ? { notifications: input.notifications } : {}),
      });
      set((prev) => {
        const tabs = prev.tabsByWorkspace[session.workspaceId] ?? NO_TABS;
        return {
          sessions: [...prev.sessions, session],
          manualOrder: [session.id, ...prev.manualOrder],
          tabsByWorkspace: {
            ...prev.tabsByWorkspace,
            [session.workspaceId]: openTab(tabs, tabForSession(session)),
          },
          page: null,
        };
      });
      return session;
    },

    // -- sheet / dialogs --------------------------------------------------
    openSheet(sessionId: string | null) {
      set({ sheet: { open: true, sessionId } });
    },
    closeSheet() {
      set({ sheet: { open: false, sessionId: null } });
    },
    confirm(spec: ConfirmSpec | null) {
      set({ confirm: spec });
    },

    // -- routines ---------------------------------------------------------
    updateRoutine(id: string, patch: Partial<Routine>) {
      set((state) => ({
        routines: state.routines.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      }));
    },
    createRoutine(sessionId: string) {
      const routine: Routine = {
        id: `r-${Date.now().toString(36)}`,
        sessionId,
        name: "New routine",
        enabled: true,
        prompt: "",
        schedule: { kind: "interval", minutes: 60 },
        lastRunAt: null,
        nextRunAt: Date.now() + 3_600_000,
        runs: [],
        createdBy: null,
      };
      set((state) => ({
        routines: [routine, ...state.routines],
        page: { kind: "routines", routineId: routine.id },
      }));
      return routine;
    },
    deleteRoutine(id: string) {
      set((state) => ({
        routines: state.routines.filter((r) => r.id !== id),
        page: { kind: "routines", routineId: null },
      }));
    },
    runRoutine(id: string) {
      const startedAt = Date.now();
      set((state) => ({
        routines: state.routines.map((r) =>
          r.id === id
            ? {
                ...r,
                lastRunAt: startedAt,
                runs: [
                  { id: `run-${startedAt}`, startedAt, finishedAt: null, status: "running", trigger: "manual" },
                  ...r.runs,
                ],
              }
            : r,
        ),
      }));
      window.setTimeout(() => {
        set((state) => ({
          routines: state.routines.map((r) =>
            r.id === id
              ? {
                  ...r,
                  runs: r.runs.map((run) =>
                    run.startedAt === startedAt
                      ? { ...run, status: "ok", finishedAt: Date.now() }
                      : run,
                  ),
                }
              : r,
          ),
        }));
      }, 2_600);
    },

    // -- misc -------------------------------------------------------------
    setTerminal(patch: Partial<TerminalPrefs>) {
      set((state) => {
        const terminal = { ...state.terminal, ...patch };
        writePref("terminal", terminal);
        return { terminal };
      });
    },
    setAgentTheme(agentTheme: string) {
      writePref("agentTheme", agentTheme);
      set({ agentTheme });
    },
    setKeymap(id: string, chord: string) {
      set((state) => {
        const keymap = { ...state.keymap, [id]: chord };
        writePref("keymap", keymap);
        return { keymap };
      });
    },
    clearKeymap(id: string) {
      set((state) => {
        const keymap = { ...state.keymap };
        delete keymap[id];
        writePref("keymap", keymap);
        return { keymap };
      });
    },
    resetKeymap() {
      writePref("keymap", {});
      set({ keymap: {} });
    },
    focusBlock(sessionId: string, blockId: string) {
      set((state) => ({
        focus: { sessionId, blockId, token: (state.focus?.token ?? 0) + 1 },
      }));
    },
    clearFocus() {
      set({ focus: null });
    },
    applyRoute(route: Route) {
      const state = get();
      switch (route.kind) {
        case "session": {
          const session = state.sessions.find((s) => s.id === route.id);
          if (session) actions.openSession(session.id);
          return;
        }
        case "file": {
          actions.openFile(route.path);
          return;
        }
        case "search":
          actions.openSearch();
          return;
        case "routines":
          actions.openRoutines(
            route.id && state.routines.some((r) => r.id === route.id) ? route.id : null,
          );
          return;
        case "settings": {
          const known = SETTINGS_SECTIONS.some((s) => s.id === route.section);
          actions.openSettings((known ? route.section : "general") as SettingsSectionId);
          return;
        }
        case "home":
          return;
      }
    },
  };
  return actions;
}

/** The surface the shell is showing, as a route. */
export function routeOf(state: AppState): Route {
  if (state.page?.kind === "search") return { kind: "search" };
  if (state.page?.kind === "routines") {
    return state.page.routineId ? { kind: "routines", id: state.page.routineId } : { kind: "routines" };
  }
  if (state.page?.kind === "settings") return { kind: "settings", section: state.page.section };
  const tabs = state.tabsByWorkspace[state.activeWorkspaceId] ?? NO_TABS;
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  if (tab?.kind === "session") return { kind: "session", id: tab.sessionId };
  if (tab?.kind === "file") return { kind: "file", path: tab.relative };
  return { kind: "home" };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialState);
  const ref = useRef(state);
  ref.current = state;

  const set = useCallback(
    (next: Partial<AppState> | ((prev: AppState) => Partial<AppState>)) => {
      setState((prev) => {
        const patch = typeof next === "function" ? next(prev) : next;
        return { ...prev, ...patch };
      });
    },
    [],
  );

  const actions = useMemo(() => buildActions(() => ref.current, set), [set]);

  // ---- the data source -------------------------------------------------
  // Workspaces first, then everything that hangs off the active one. A live
  // daemon answers an empty store, which is correct and is what the empty
  // states are for.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const workspaces = await SOURCE.workspaces();
        if (!alive) return;
        const active =
          workspaces.find((w) => w.id === PREFERRED_WORKSPACE) ?? workspaces[0] ?? null;
        set({ workspaces, activeWorkspaceId: active?.id ?? "", ready: workspaces.length === 0 });
      } catch {
        if (alive) set({ ready: true });
      }
    })();
    const offStatus = SOURCE.onSessionStatus((id, status) => {
      set((prev) => ({
        sessions: prev.sessions.map((s) => (s.id === id ? { ...s, status } : s)),
      }));
    });
    const offConnection = SOURCE.onConnectionChange?.((connected) => set({ connected }));
    return () => {
      alive = false;
      offStatus();
      offConnection?.();
    };
  }, [set]);

  const workspaceId = state.activeWorkspaceId;
  const workspacePath = state.workspaces.find((w) => w.id === workspaceId)?.path ?? "";
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void (async () => {
      const [sessions, files, routines] = await Promise.all([
        SOURCE.sessions(workspaceId),
        SOURCE.projectFiles(workspacePath),
        SOURCE.routines(),
      ]);
      if (!alive) return;
      set((prev) => ({
        sessions,
        files,
        routines,
        ready: true,
        manualOrder: prev.manualOrder.length ? prev.manualOrder : sessions.map((s) => s.id),
        tabsByWorkspace: prev.tabsByWorkspace[workspaceId]
          ? prev.tabsByWorkspace
          : { ...prev.tabsByWorkspace, [workspaceId]: seedTabs(sessions, files) },
      }));
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, workspacePath, set]);

  // The hash can only be honoured once the sessions it names exist.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current || !state.ready) return;
    booted.current = true;
    actions.applyRoute(parseHash(location.hash));
  }, [actions, state.ready]);

  useEffect(() => {
    const onHash = () => actions.applyRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [actions]);

  const route = routeOf(state);
  const routeKey = formatRoute(route);
  useEffect(() => {
    writeHash(parseHash(routeKey));
  }, [routeKey]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = state.theme === "system" ? (media.matches ? "dark" : "light") : state.theme;
      root.dataset.theme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.theme]);

  const value = useMemo<Ctx>(() => {
    const tabs = state.tabsByWorkspace[state.activeWorkspaceId] ?? NO_TABS;
    return {
      ...state,
      set,
      actions,
      tabs,
      activeTab: tabs.tabs.find((t) => t.id === tabs.activeId) ?? null,
      workspace:
        state.workspaces.find((w) => w.id === state.activeWorkspaceId) ??
        state.workspaces[0] ??
        NO_WORKSPACE,
    };
  }, [state, set, actions]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
