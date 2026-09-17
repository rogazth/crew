import { Sidebar } from "@cloudflare/kumo";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { AgentSheet, type AgentDraft } from "./chrome/AgentSheet";
import { MIN_SAVE_MS } from "./lib/timing";
import { CommandPalette, type PaletteMode } from "./chrome/CommandPalette";
import { ConfirmDialog } from "./chrome/ConfirmDialog";
import { AppSidebar } from "./chrome/AppSidebar";
import { TabBar } from "./chrome/TabBar";
import type { Launch } from "./chrome/TabLauncher";
import { useCommands } from "./hooks/useCommand";
import { useConfirmations } from "./hooks/useConfirmations";
import { useProjectFiles } from "./hooks/useProjectFiles";
import { useSelectAllScope } from "./hooks/useSelectAllScope";
import { useSessions } from "./hooks/useSessions";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useTabs } from "./hooks/useTabs";
import { AgentThemeProvider } from "./hooks/useAgentTheme";
import { TerminalPrefsProvider } from "./hooks/useTerminalPrefs";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./lib/providers";
import { fileTabId, sessionTabId, stubTabId } from "./lib/tabs";
import type { ProjectFile, Session, StubKind } from "./lib/types";
import { SETTINGS_DEFAULT, type SettingsSectionId } from "./lib/settings";
import { startScheduler } from "./lib/scheduler";
import { newRoutineDraft, type RoutineDraft } from "./lib/routines";
import { nextSessionName } from "./lib/workspaces";
import { RoutinesView } from "./surfaces/RoutinesView";
import { SettingsView } from "./surfaces/SettingsView";
import { WorkspacePanes } from "./surfaces/WorkspacePanes";

type Sheet = { session: Session | null };

/**
 * Pages take over the main area; only settings swaps the sidebar too. They stack over
 * the tabs, so anything that opens or picks a tab has to leave the page first.
 */
type View =
  | { kind: "workspace" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; draft: RoutineDraft | null };

export function App() {
  useEffect(startScheduler, []);
  useSelectAllScope();

  const workspaces = useWorkspaces();
  const sidebar = useSidebarWidth();
  const active = workspaces.active;
  const { sessions, create, update, rename, remove, reorder, setStatus } =
    useSessions(active?.id ?? null);
  const tabs = useTabs(active?.id ?? null);
  const files = useProjectFiles(active?.path ?? null);
  const confirms = useConfirmations({
    closeTabsFor: tabs.closeForSession,
    removeSession: remove,
    removeWorkspace: workspaces.remove,
  });

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabs.tabs.find((t) => t.id === id);
      const session =
        tab?.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined;
      if (!session) {
        tabs.close(id);
        return;
      }
      confirms.askCloseTab(session, () => tabs.close(id));
    },
    [confirms, sessions, tabs],
  );

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<View>({ kind: "workspace" });
  const settings = view.kind === "settings" ? view.section : null;
  const closeView = useCallback(() => setView({ kind: "workspace" }), []);

  /** Wraps a tab action so it lands in view instead of behind whatever page is up. */
  const inTabs = useCallback(
    (act: () => void) => () => {
      closeView();
      act();
    },
    [closeView],
  );

  const openSession = useCallback(
    (session: Session) => {
      closeView();
      tabs.open({ id: sessionTabId(session.id), kind: "session", sessionId: session.id });
    },
    [closeView, tabs],
  );

  /** A message from another agent names its sender; the name opens its tab. */
  const openSessionById = useCallback(
    (id: string) => {
      const found = sessions.find((session) => session.id === id);
      if (found) openSession(found);
    },
    [sessions, openSession],
  );

  const openFile = useCallback(
    (file: ProjectFile) => {
      closeView();
      tabs.open({ id: fileTabId(file.path), kind: "file", path: file.path, relative: file.relative });
      setPalette(null);
    },
    [closeView, tabs],
  );

  // Sessions open straight away; the name is derived, never prompted.
  const newSession = useCallback(async () => {
    const session = await create("terminal", {
      name: nextSessionName(sessions, DEFAULT_PROVIDER),
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      description: "",
      autonomy: "ask",
    });
    if (session) openSession(session);
  }, [create, openSession, sessions]);

  const newAgent = useCallback(() => setSheet({ session: null }), []);

  const newRoutineFor = useCallback(
    (session: Session) => () => setView({ kind: "routines", draft: newRoutineDraft(session.id) }),
    [],
  );

  const changeModel = useCallback(
    (session: Session, provider: string, model: string) =>
      void update(session.id, { ...session, provider, model }),
    [update],
  );

  const openStub = useCallback(
    (stub: StubKind, title: string) => {
      closeView();
      tabs.open({ id: stubTabId(stub), kind: "stub", stub, title });
    },
    [closeView, tabs],
  );

  const launch = useCallback(
    (item: Launch) => {
      if (item.kind === "stub") openStub(item.stub, item.title);
      if (item.kind === "new-agent") newAgent();
      if (item.kind === "new-session") void newSession();
      if (item.kind === "session") openSession(item.session);
    },
    [newAgent, newSession, openSession, openStub],
  );

  // One sheet serves both create and edit. The sheet closes itself so its exit can play.
  const saveSheet = useCallback(
    async (draft: AgentDraft) => {
      const editing = sheet?.session;
      // Writing is instant, which reads as cheap; the floor holds the spinner so the
      // sidebar row, the tab and the sheet's exit all land on the same beat.
      const settle = new Promise((r) => setTimeout(r, MIN_SAVE_MS));
      if (editing) {
        await update(editing.id, draft, settle);
        return;
      }
      const session = await create("agent", draft, settle);
      if (session) openSession(session);
    },
    [create, openSession, sheet, update],
  );

  const togglePalette = useCallback(
    (mode: PaletteMode) => setPalette((open) => (open === mode ? null : mode)),
    [],
  );

  useCommands({
    "open-palette": () => togglePalette("all"),
    "go-to-file": () => togglePalette("files"),
    "open-actions": () => togglePalette("actions"),
    "open-workspace": workspaces.create,
    // The picker anchors to a sidebar row, so a hidden sidebar comes back first.
    "switch-workspace": () => {
      setSidebarOpen(true);
      setPickerOpen((open) => !open);
    },
    "next-workspace": () => workspaces.step(1),
    "prev-workspace": () => workspaces.step(-1),
    "workspace-1": () => workspaces.activateAt(0),
    "workspace-2": () => workspaces.activateAt(1),
    "workspace-3": () => workspaces.activateAt(2),
    "workspace-4": () => workspaces.activateAt(3),
    "workspace-5": () => workspaces.activateAt(4),
    "workspace-6": () => workspaces.activateAt(5),
    "workspace-7": () => workspaces.activateAt(6),
    "workspace-8": () => workspaces.activateAt(7),
    "workspace-9": () => workspaces.activateAt(8),
    "toggle-sidebar": () => setSidebarOpen((open) => !open),
    "new-agent": newAgent,
    "new-session": () => void newSession(),
    "open-routines": () =>
      setView((open) =>
        open.kind === "routines" ? { kind: "workspace" } : { kind: "routines", draft: null },
      ),
    "open-settings": () =>
      setView((open) =>
        open.kind === "settings" ? { kind: "workspace" } : { kind: "settings", section: SETTINGS_DEFAULT },
      ),
    "reopen-tab": inTabs(tabs.reopen),
    "next-tab": inTabs(() => tabs.step(1)),
    "prev-tab": inTabs(() => tabs.step(-1)),
    "tab-1": inTabs(() => tabs.activate(0)),
    "tab-2": inTabs(() => tabs.activate(1)),
    "tab-3": inTabs(() => tabs.activate(2)),
    "tab-4": inTabs(() => tabs.activate(3)),
    "tab-5": inTabs(() => tabs.activate(4)),
    "tab-6": inTabs(() => tabs.activate(5)),
    "tab-7": inTabs(() => tabs.activate(6)),
    "tab-8": inTabs(() => tabs.activate(7)),
    "last-tab": inTabs(() => tabs.activate(-1)),
    close: () => {
      if (palette) setPalette(null);
      else if (sheet) setSheet(null);
      else if (view.kind !== "workspace") closeView();
      else if (tabs.active) closeTab(tabs.active.id);
    },
  });

  if (workspaces.loading || sidebar.width === null) return <div className="h-full" />;

  const activeSessionId = tabs.active?.kind === "session" ? tabs.active.sessionId : null;

  return (
    <TerminalPrefsProvider>
    <AgentThemeProvider>
    <Sidebar.Provider
      contained
      collapsible="offcanvas"
      animationDuration={0}
      resizable
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      defaultWidth={sidebar.width}
      minWidth={200}
      maxWidth={560}
      onWidthChange={sidebar.commit}
      // kumo sets --sidebar-bg to the canvas colour with a class of equal weight,
      // so the sidebar tone has to arrive inline to beat it.
      style={{ "--sidebar-bg": "var(--color-kumo-elevated)" } as CSSProperties}
      className="h-full"
    >
      {active && (
        <AppSidebar
          settings={settings}
          onSelectSettings={(section) => setView({ kind: "settings", section })}
          onCloseSettings={closeView}
          sessions={{
            workspace: active,
            workspaces: workspaces.workspaces,
            pickerOpen,
            onPickerOpenChange: setPickerOpen,
            onSelectWorkspace: workspaces.activate,
            onCreateWorkspace: workspaces.create,
            onRenameWorkspace: workspaces.rename,
            onRemoveWorkspace: confirms.askWorkspace,
            onReorderWorkspaces: workspaces.reorder,
            sessions,
            activeSessionId,
            settingsOpen: settings !== null,
            routinesOpen: view.kind === "routines",
            onSelect: openSession,
            onNewAgent: newAgent,
            onNewSession: newSession,
            onOpenRoutines: () => setView({ kind: "routines", draft: null }),
            onOpenSettings: () => setView({ kind: "settings", section: SETTINGS_DEFAULT }),
            onEdit: (session) => setSheet({ session }),
            onRename: (session, name) => void rename(session.id, name),
            onRemove: confirms.askSession,
            onRemoveMany: confirms.askSessions,
            onReorder: reorder,
          }}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        {settings && <SettingsView section={settings} />}
        {view.kind === "routines" && active && (
          <RoutinesView
            // A draft arriving from the agent drawer has to reopen the editor even
            // when the page is already up.
            key={view.draft?.key ?? "routines"}
            draft={view.draft}
            workspaces={workspaces.workspaces}
            activeWorkspaceId={active.id}
            agents={sessions.filter((session) => session.kind === "agent")}
            onConfirm={confirms.ask}
          />
        )}
        {/* Hidden, not unmounted: agent and terminal processes stay alive. */}
        <div hidden={view.kind !== "workspace"} className="flex min-h-0 flex-1 flex-col">
          <TabBar
            inset={!sidebarOpen}
            tabs={tabs.tabs}
            activeId={tabs.active?.id ?? null}
            sessions={sessions}
            onSelect={tabs.select}
            onClose={closeTab}
            onLaunch={launch}
          />

          {workspaces.error && (
            <div className="border-b border-border px-3 py-2 text-danger">{workspaces.error}</div>
          )}

          <WorkspacePanes
            tab={tabs.active}
            tabs={tabs.tabs}
            sessions={sessions}
            cwd={active?.path ?? null}
            hasWorkspace={active !== null}
            onCreateWorkspace={workspaces.create}
            onStatus={setStatus}
            onModel={changeModel}
            onOpenFile={openFile}
            onOpenSession={openSessionById}
            files={files}
          />
        </div>
      </main>

      {palette && active && (
        <CommandPalette
          key={palette}
          mode={palette}
          files={files}
          sessions={sessions}
          workspaces={workspaces.workspaces}
          activeWorkspaceId={active.id}
          onOpenFile={openFile}
          onOpenSession={openSession}
          onSelectWorkspace={workspaces.activate}
          onClose={() => setPalette(null)}
        />
      )}

      <ConfirmDialog confirm={confirms.confirm} onClose={confirms.close} />

      {sheet && (
        <AgentSheet
          session={sheet.session}
          existingNames={sessions.filter((s) => s.kind === "agent").map((s) => s.name)}
          onNewRoutine={sheet.session ? newRoutineFor(sheet.session) : null}
          onSave={saveSheet}
          onClose={() => setSheet(null)}
        />
      )}
    </Sidebar.Provider>
    </AgentThemeProvider>
    </TerminalPrefsProvider>
  );
}
