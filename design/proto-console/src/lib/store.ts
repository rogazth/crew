import { useSyncExternalStore } from "react";
import { COMMANDS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "@crew/fixtures";
import type {
  Chord,
  CommandId,
  ProjectFile,
  Routine,
  Session,
  SessionStatus,
  SettingsSectionId,
  StubKind,
  Tab,
  Workspace,
} from "@crew/fixtures";
import { source } from "./source";
import {
  DEFAULT_SIDEBAR_PREFS,
  DEFAULT_TERMINAL,
  load,
  save,
  type Density,
  type SidebarPrefs,
  type TerminalPrefs,
  type Theme,
} from "./prefs";
import {
  NO_TABS,
  activeTab,
  closeTab,
  fileTabId,
  openTab,
  reopenTab,
  sessionTabId,
  stepTab,
  stubTabId,
  tabAt,
  type TabState,
} from "./tabs";

export type Page =
  | { kind: "none" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; routineId: string | null }
  | { kind: "search"; query: string };

export type PaletteFilter = "all" | "agents" | "sessions" | "files" | "actions";

export type Confirm = {
  title: string;
  description?: string;
  action: string;
  destructive?: boolean;
  onConfirm: () => void;
};

export type Overlay =
  | null
  | { kind: "palette"; filter: PaletteFilter; seed: string }
  | { kind: "launcher" }
  | { kind: "sheet"; sessionId: string | null }
  | { kind: "confirm"; confirm: Confirm }
  | { kind: "shortcuts" }
  | { kind: "workspaces" };

export type Toast = { id: number; text: string } | null;

/** Where the transcript should jump once the session opens. */
export type PendingScroll = { sessionId: string; blockId: string } | null;

export type State = {
  workspaces: Workspace[];
  workspaceId: string;
  sessions: Session[];
  tabsByWorkspace: Record<string, TabState>;
  page: Page;
  overlay: Overlay;
  sidebar: {
    collapsed: boolean;
    width: number;
    view: "sessions" | "settings";
    query: string;
    focus: number;
  };
  prefs: SidebarPrefs;
  selection: string[];
  theme: Theme;
  density: Density;
  terminal: TerminalPrefs;
  keys: Record<string, Chord>;
  routines: Routine[];
  files: ProjectFile[];
  /** False until the data source has answered; the shell renders regardless. */
  ready: boolean;
  /** Live sources only. `null` means the question does not apply. */
  connected: boolean | null;
  dirty: Record<string, string>;
  toast: Toast;
  pendingScroll: PendingScroll;
  /** Bumped when the demo menu wants every open transcript to re-read fixtures. */
  epoch: number;
};

const defaultKeys = (): Record<string, Chord> => {
  const out: Record<string, Chord> = {};
  for (const [id, def] of Object.entries(COMMANDS)) out[id] = { ...def.keys };
  return out;
};

/**
 * The demo opens with four tabs, but only the ones the source actually has —
 * a live daemon starts with an empty store and must open with nothing.
 */
function seedTabs(sessions: Session[], workspaceId: string, files: ProjectFile[]): Record<string, TabState> {
  const tabs: Tab[] = [];
  for (const id of ["s-harness", "s-relay"]) {
    if (sessions.some((session) => session.id === id)) {
      tabs.push({ id: sessionTabId(id), kind: "session", sessionId: id });
    }
  }
  const file = files.find((entry) => entry.relative === "src/lib/tabs.ts");
  if (file) tabs.push({ id: fileTabId(file.relative), kind: "file", path: file.path, relative: file.relative });
  if (sessions.some((session) => session.id === "t-build")) {
    tabs.push({ id: sessionTabId("t-build"), kind: "session", sessionId: "t-build" });
  }
  if (tabs.length === 0) return {};
  return { [workspaceId]: { tabs, activeId: tabs[0]!.id, closed: [] } };
}

function initial(): State {
  return {
    workspaces: [],
    workspaceId: "",
    sessions: [],
    tabsByWorkspace: {},
    page: { kind: "none" },
    overlay: null,
    sidebar: {
      collapsed: false,
      width: load("sidebar-width", 268),
      view: "sessions",
      query: "",
      focus: -1,
    },
    prefs: load("sidebar-prefs", DEFAULT_SIDEBAR_PREFS),
    selection: [],
    theme: load<Theme>("theme", "system"),
    density: load<Density>("density", "comfortable"),
    terminal: load("terminal", DEFAULT_TERMINAL),
    keys: { ...defaultKeys(), ...load<Record<string, Chord>>("keys", {}) },
    routines: [],
    files: [],
    ready: false,
    connected: null,
    dirty: {},
    toast: null,
    pendingScroll: null,
    epoch: 0,
  };
}

let toastSeq = 0;

class Store {
  state: State = initial();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  /**
   * One pass over the data source. Everything below is optimistic on top of it:
   * a mutation updates local state and tells the source, rather than waiting.
   */
  async hydrate(): Promise<void> {
    const workspaces = await source.workspaces();
    const workspaceId = workspaces.find((w) => w.id === "ws-crew")?.id ?? workspaces[0]?.id ?? "";
    const lists = await Promise.all(workspaces.map((w) => source.sessions(w.id)));
    const seen = new Set<string>();
    const sessions: Session[] = [];
    for (const session of lists.flat()) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
    const cwd = workspaces.find((w) => w.id === workspaceId)?.path ?? "";
    const [routines, files] = await Promise.all([source.routines(), source.projectFiles(cwd)]);
    this.set({
      workspaces,
      workspaceId,
      sessions,
      routines,
      files,
      ready: true,
      tabsByWorkspace: seedTabs(sessions, workspaceId, files),
      connected: source.connected ? source.connected() : null,
    });
    source.onSessionStatus((id, status) => this.setStatus(id, status));
    source.onConnectionChange?.((connected) => this.set({ connected }));
  }

  private set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  // --- derived ---------------------------------------------------------
  get tabs(): TabState {
    return this.state.tabsByWorkspace[this.state.workspaceId] ?? NO_TABS;
  }

  get activeTab(): Tab | null {
    return activeTab(this.tabs);
  }

  session(id: string): Session | undefined {
    return this.state.sessions.find((s) => s.id === id);
  }

  private setTabs(next: TabState, keepSelection = false) {
    this.set((s) => ({
      tabsByWorkspace: { ...s.tabsByWorkspace, [s.workspaceId]: next },
      page: { kind: "none" },
      selection: keepSelection ? s.selection : [],
    }));
  }

  // --- tabs ------------------------------------------------------------
  openSession(id: string, opts: { keepSelection?: boolean } = {}) {
    const session = this.session(id);
    if (!session) return;
    if (session.workspaceId !== this.state.workspaceId) this.setWorkspace(session.workspaceId);
    const tabs = this.state.tabsByWorkspace[session.workspaceId] ?? NO_TABS;
    const next = openTab(tabs, { id: sessionTabId(id), kind: "session", sessionId: id });
    this.set((s) => ({
      tabsByWorkspace: { ...s.tabsByWorkspace, [session.workspaceId]: next },
      page: { kind: "none" },
      selection: opts.keepSelection ? s.selection : [],
    }));
  }

  openFile(relative: string, line?: number) {
    const file = this.state.files.find((f) => f.relative === relative);
    const path = file?.path ?? `/Users/you/crew/${relative}`;
    this.setTabs(openTab(this.tabs, { id: fileTabId(relative), kind: "file", path, relative }));
    if (line !== undefined) this.set({ toast: { id: (toastSeq += 1), text: `${relative}:${line}` } });
  }

  openStub(stub: StubKind, title: string) {
    this.setTabs(openTab(this.tabs, { id: stubTabId(stub), kind: "stub", stub, title }));
  }

  setActiveTab(id: string) {
    this.setTabs({ ...this.tabs, activeId: id });
  }

  requestCloseTab(id: string) {
    const tab = this.tabs.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "session") {
      const session = this.session(tab.sessionId);
      if (session && (session.status === "working" || session.status === "needs-input")) {
        this.confirm({
          title: `Close ${session.name}?`,
          description:
            session.status === "working"
              ? "The session is still running. Closing the tab leaves it running in the background."
              : "The session is waiting for an answer. Closing the tab leaves the question open.",
          action: "Close tab",
          onConfirm: () => this.closeTab(id),
        });
        return;
      }
    }
    if (tab.kind === "file" && this.state.dirty[tab.relative] !== undefined) {
      this.confirm({
        title: `Discard changes to ${tab.relative.split("/").pop()}?`,
        description: "The file has unsaved edits.",
        action: "Discard",
        destructive: true,
        onConfirm: () => {
          this.set((s) => {
            const dirty = { ...s.dirty };
            delete dirty[tab.relative];
            return { dirty };
          });
          this.closeTab(id);
        },
      });
      return;
    }
    this.closeTab(id);
  }

  closeTab(id: string) {
    this.setTabs(closeTab(this.tabs, id));
  }

  closeActiveTab() {
    const id = this.tabs.activeId;
    if (id) this.requestCloseTab(id);
  }

  reopenTab() {
    this.setTabs(reopenTab(this.tabs));
  }

  stepTab(delta: number) {
    this.setTabs(stepTab(this.tabs, delta));
  }

  tabAt(index: number) {
    this.setTabs(tabAt(this.tabs, index));
  }

  lastTab() {
    this.setTabs(tabAt(this.tabs, this.tabs.tabs.length - 1));
  }

  moveTab(from: number, to: number) {
    const tabs = this.tabs.tabs.slice();
    const [moved] = tabs.splice(from, 1);
    if (!moved) return;
    tabs.splice(to, 0, moved);
    this.setTabs({ ...this.tabs, tabs }, true);
  }

  // --- pages -----------------------------------------------------------
  openSettings(section: SettingsSectionId = "general") {
    this.set({ page: { kind: "settings", section }, overlay: null });
    this.set((s) => ({ sidebar: { ...s.sidebar, view: "settings", collapsed: false } }));
  }

  openRoutines(routineId: string | null = null) {
    this.set({ page: { kind: "routines", routineId }, overlay: null });
  }

  openSearch(query = "") {
    this.set({ page: { kind: "search", query }, overlay: null });
  }

  setSearchQuery(query: string) {
    this.set((s) => (s.page.kind === "search" ? { page: { kind: "search", query } } : {}));
  }

  closePage() {
    this.set((s) => ({
      page: { kind: "none" },
      sidebar: { ...s.sidebar, view: "sessions" },
    }));
  }

  // --- workspaces ------------------------------------------------------
  setWorkspace(id: string) {
    if (!this.state.workspaces.some((w) => w.id === id)) return;
    this.set({ workspaceId: id, selection: [], page: { kind: "none" }, overlay: null });
  }

  stepWorkspace(delta: number) {
    const { workspaces, workspaceId } = this.state;
    const index = workspaces.findIndex((w) => w.id === workspaceId);
    const next = (((index + delta) % workspaces.length) + workspaces.length) % workspaces.length;
    const target = workspaces[next];
    if (target) this.setWorkspace(target.id);
  }

  workspaceAt(index: number) {
    const target = this.state.workspaces[index];
    if (target) this.setWorkspace(target.id);
  }

  createWorkspace(name: string, path: string) {
    const id = `ws-${Date.now().toString(36)}`;
    this.set((s) => ({
      workspaces: [...s.workspaces, { id, name, path, createdAt: Date.now() }],
    }));
    this.setWorkspace(id);
    void source.createWorkspace(name, path);
  }

  renameWorkspace(id: string, name: string) {
    this.set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) }));
    void source.renameWorkspace(id, name);
  }

  deleteWorkspace(id: string) {
    void source.deleteWorkspace(id);
    this.set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const tabsByWorkspace = { ...s.tabsByWorkspace };
      delete tabsByWorkspace[id];
      return {
        workspaces,
        tabsByWorkspace,
        workspaceId: s.workspaceId === id ? (workspaces[0]?.id ?? "") : s.workspaceId,
      };
    });
  }

  reorderWorkspaces(from: number, to: number) {
    this.set((s) => {
      const workspaces = s.workspaces.slice();
      const [moved] = workspaces.splice(from, 1);
      if (!moved) return {};
      workspaces.splice(to, 0, moved);
      void source.reorderWorkspaces(workspaces.map((w) => w.id));
      return { workspaces };
    });
  }

  // --- sessions --------------------------------------------------------
  createSession(input: Partial<Session> & { name: string; kind: Session["kind"] }): Session {
    const id = input.id ?? `${input.kind === "terminal" ? "t" : "s"}-${Date.now().toString(36)}`;
    const session: Session = {
      id,
      workspaceId: this.state.workspaceId,
      kind: input.kind,
      name: input.name,
      provider: input.provider ?? DEFAULT_PROVIDER,
      model: input.model ?? (input.kind === "terminal" ? "" : DEFAULT_MODEL),
      providerSessionId: null,
      description: input.description ?? "",
      notifications: input.notifications ?? true,
      autonomy: input.autonomy ?? "ask",
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: input.createdBy ?? null,
    };
    this.set((s) => ({ sessions: [...s.sessions, session] }));
    void source.createSession(session.workspaceId, session.kind, {
      name: session.name,
      provider: session.provider,
      model: session.model,
      description: session.description,
      autonomy: session.autonomy,
      notifications: session.notifications,
    });
    return session;
  }

  addSessions(extra: Session[]) {
    if (extra.length === 0) return;
    this.set((s) => ({ sessions: [...s.sessions, ...extra] }));
  }

  updateSession(id: string, patch: Partial<Session>) {
    this.set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x)),
    }));
    const next = this.session(id);
    if (!next) return;
    if (patch.name !== undefined && Object.keys(patch).length === 1) {
      void source.renameSession(id, patch.name);
      return;
    }
    void source.updateSession(id, {
      name: next.name,
      provider: next.provider,
      model: next.model,
      description: next.description,
      autonomy: next.autonomy,
      notifications: next.notifications,
    });
  }

  setStatus(id: string, status: SessionStatus) {
    this.set((s) =>
      s.sessions.some((x) => x.id === id && x.status !== status)
        ? {
            sessions: s.sessions.map((x) =>
              x.id === id ? { ...x, status, updatedAt: Date.now() } : x,
            ),
          }
        : {},
    );
  }

  deleteSessions(ids: string[]) {
    for (const id of ids) void source.deleteSession(id);
    this.set((s) => {
      const gone = new Set(ids);
      const tabs = s.tabsByWorkspace[s.workspaceId] ?? NO_TABS;
      const kept = tabs.tabs.filter((t) => t.kind !== "session" || !gone.has(t.sessionId));
      const activeStillThere = kept.some((t) => t.id === tabs.activeId);
      return {
        sessions: s.sessions.filter((x) => !gone.has(x.id)),
        selection: [],
        tabsByWorkspace: {
          ...s.tabsByWorkspace,
          [s.workspaceId]: {
            ...tabs,
            tabs: kept,
            activeId: activeStillThere ? tabs.activeId : (kept.at(-1)?.id ?? null),
          },
        },
      };
    });
  }

  reorderSessions(fromId: string, toId: string) {
    this.set((s) => {
      const sessions = s.sessions.slice();
      const from = sessions.findIndex((x) => x.id === fromId);
      const to = sessions.findIndex((x) => x.id === toId);
      if (from < 0 || to < 0 || from === to) return {};
      const [moved] = sessions.splice(from, 1);
      if (!moved) return {};
      sessions.splice(to, 0, moved);
      void source.reorderSessions(sessions.map((x) => x.id));
      return { sessions };
    });
  }

  // --- selection -------------------------------------------------------
  setSelection(ids: string[]) {
    this.set({ selection: ids });
  }

  toggleSelection(id: string) {
    this.set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id],
    }));
  }

  // --- sidebar ---------------------------------------------------------
  toggleSidebar() {
    this.set((s) => ({ sidebar: { ...s.sidebar, collapsed: !s.sidebar.collapsed } }));
  }

  setSidebarWidth(width: number) {
    const clamped = Math.max(200, Math.min(560, Math.round(width)));
    save("sidebar-width", clamped);
    this.set((s) => ({ sidebar: { ...s.sidebar, width: clamped } }));
  }

  setSidebarView(view: "sessions" | "settings") {
    this.set((s) => ({ sidebar: { ...s.sidebar, view } }));
  }

  setQuery(query: string) {
    this.set((s) => ({ sidebar: { ...s.sidebar, query, focus: -1 } }));
  }

  setFocus(focus: number) {
    this.set((s) => ({ sidebar: { ...s.sidebar, focus } }));
  }

  setPrefs(patch: Partial<SidebarPrefs>) {
    this.set((s) => {
      const prefs = { ...s.prefs, ...patch };
      save("sidebar-prefs", prefs);
      return { prefs };
    });
  }

  toggleGroupCollapse(key: string) {
    const held = this.state.prefs.collapsedGroups;
    this.setPrefs({
      collapsedGroups: held.includes(key) ? held.filter((x) => x !== key) : [...held, key],
    });
  }

  // --- appearance ------------------------------------------------------
  setTheme(theme: Theme) {
    save("theme", theme);
    this.set({ theme });
  }

  toggleTheme() {
    const resolved = resolveTheme(this.state.theme);
    this.setTheme(resolved === "dark" ? "light" : "dark");
  }

  setDensity(density: Density) {
    save("density", density);
    this.set({ density });
  }

  setTerminal(patch: Partial<TerminalPrefs>) {
    this.set((s) => {
      const terminal = { ...s.terminal, ...patch };
      save("terminal", terminal);
      return { terminal };
    });
  }

  setKey(id: CommandId, chord: Chord) {
    this.set((s) => {
      const keys = { ...s.keys, [id]: chord };
      save("keys", keys);
      return { keys };
    });
  }

  resetKeys() {
    save("keys", {});
    this.set({ keys: defaultKeys() });
  }

  // --- routines --------------------------------------------------------
  saveRoutine(routine: Routine) {
    this.set((s) => ({
      routines: s.routines.some((r) => r.id === routine.id)
        ? s.routines.map((r) => (r.id === routine.id ? routine : r))
        : [...s.routines, routine],
    }));
  }

  deleteRoutine(id: string) {
    this.set((s) => ({ routines: s.routines.filter((r) => r.id !== id) }));
  }

  runRoutine(id: string) {
    const at = Date.now();
    this.set((s) => ({
      routines: s.routines.map((r) =>
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
    }));
    window.setTimeout(() => {
      this.set((s) => ({
        routines: s.routines.map((r) =>
          r.id === id
            ? {
                ...r,
                runs: r.runs.map((run) =>
                  run.id === `run-${at}`
                    ? { ...run, finishedAt: Date.now(), status: "ok" as const }
                    : run,
                ),
              }
            : r,
        ),
      }));
    }, 2_600);
  }

  // --- files -----------------------------------------------------------
  setDirty(relative: string, text: string) {
    this.set((s) => ({ dirty: { ...s.dirty, [relative]: text } }));
  }

  saveFile(relative: string) {
    const contents = this.state.dirty[relative];
    if (contents === undefined) return;
    const file = this.state.files.find((entry) => entry.relative === relative);
    void source.writeTextFile(file?.path ?? relative, contents);
    this.set((s) => {
      const dirty = { ...s.dirty };
      delete dirty[relative];
      return { dirty, toast: { id: (toastSeq += 1), text: `Saved ${relative}` } };
    });
  }

  // --- overlays --------------------------------------------------------
  openOverlay(overlay: Overlay) {
    this.set({ overlay });
  }

  closeOverlay() {
    this.set({ overlay: null });
  }

  openPalette(filter: PaletteFilter = "all", seed = "") {
    this.set({ overlay: { kind: "palette", filter, seed } });
  }

  confirm(confirm: Confirm) {
    this.set({ overlay: { kind: "confirm", confirm } });
  }

  notify(text: string) {
    this.set({ toast: { id: (toastSeq += 1), text } });
  }

  clearToast(id: number) {
    this.set((s) => (s.toast?.id === id ? { toast: null } : {}));
  }

  scrollTo(sessionId: string, blockId: string) {
    this.openSession(sessionId);
    this.set({ pendingScroll: { sessionId, blockId } });
  }

  clearPendingScroll() {
    this.set({ pendingScroll: null });
  }

  bumpEpoch() {
    this.set((s) => ({ epoch: s.epoch + 1 }));
  }
}

export const store = new Store();

export function useApp(): State {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
