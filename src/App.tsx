import { Sidebar } from "@cloudflare/kumo";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { AgentSheetHost } from "./chrome/AgentSheet";
import { CommandPalette, type PaletteMode } from "./chrome/CommandPalette";
import { ConfirmDialog } from "./chrome/ConfirmDialog";
import { AppSidebar } from "./chrome/AppSidebar";
import { TabBar } from "./chrome/TabBar";
import { useAgentSheet } from "./hooks/useAgentSheet";
import { useAppCommands } from "./hooks/useAppCommands";
import { useSessionTitle } from "./hooks/useSessionTitle";
import { useConfirmations } from "./hooks/useConfirmations";
import { useLaunch } from "./hooks/useLaunch";
import { useNavigation } from "./hooks/useNavigation";
import { useProjectFiles } from "./hooks/useProjectFiles";
import { useSelectAllScope } from "./hooks/useSelectAllScope";
import { useSessions } from "./hooks/useSessions";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useTabs } from "./hooks/useTabs";
import { AgentThemeProvider } from "./hooks/useAgentTheme";
import { TerminalPrefsProvider } from "./hooks/useTerminalPrefs";
import { useWorkspaces } from "./hooks/useWorkspaces";
import type { Session } from "./lib/types";
import { Pages } from "./surfaces/Pages";
import { usePages } from "./hooks/usePages";
import { boot } from "./lib/agentRuntime";
import { WorkspacePanes } from "./surfaces/WorkspacePanes";

/**
 * Pages take over the main area; only settings swaps the sidebar too. They stack over
 * the tabs, so anything that opens or picks a tab has to leave the page first.
 */
export function App() {
  // The daemon runs turns whether or not anyone asked for one — a routine comes
  // due, an agent writes to another — so the window listens from the moment it
  // opens rather than from the first thing the user sends.
  useEffect(() => void boot(), []);
  useSelectAllScope();

  const workspaces = useWorkspaces();
  const sidebar = useSidebarWidth();
  const active = workspaces.active;
  const workspaceId = active?.id ?? null;
  const {
    sessions,
    all,
    create,
    update,
    rename,
    adoptName,
    remove,
    reorder,
    setStatus,
    dropWorkspace: forgetSessions,
  } = useSessions(workspaceId);
  useSessionTitle(sessions, adoptName);
  const tabs = useTabs(workspaceId);
  const files = useProjectFiles(active?.path ?? null);

  // Its panes go first: dropping them is what stops the terminals it was running.
  const { dropWorkspace: forgetTabs } = tabs;
  const { remove: deleteWorkspace } = workspaces;
  const removeWorkspace = useCallback(
    async (id: string) => {
      forgetTabs(id);
      forgetSessions(id);
      await deleteWorkspace(id);
    },
    [deleteWorkspace, forgetSessions, forgetTabs],
  );

  const confirms = useConfirmations({
    closeTabsFor: tabs.closeForSession,
    removeSession: remove,
    removeWorkspace,
  });

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Destructured: the hook returns a fresh object each render, and these
  // callbacks are dependencies of half the shell.
  const { page, settings, isWorkspace, isRoutines, close: closePage, toggle: togglePage, openSettings, openRoutines } = usePages();

  const nav = useNavigation({ tabs, sessions, confirms, removeSession: remove, closePage });
  const sheet = useAgentSheet({ create, update, openSession: nav.openSession });
  const { newSession, launch } = useLaunch({
    sessions,
    create,
    openSession: nav.openSession,
    openStub: nav.openStub,
    openBrowser: () => nav.openBrowser(),
    newAgent: sheet.newAgent,
  });

  const changeModel = useCallback(
    (session: Session, provider: string, model: string) =>
      void update(session.id, { ...session, provider, model }),
    [update],
  );

  useAppCommands({
    workspaces,
    tabs,
    pages: { isWorkspace, close: closePage, toggle: togglePage },
    palette,
    togglePalette: (mode: PaletteMode) => setPalette((open) => (open === mode ? null : mode)),
    closePalette: () => setPalette(null),
    sheetOpen: sheet.sheet !== null,
    closeSheet: sheet.close,
    toggleSidebar: () => setSidebarOpen((open) => !open),
    // The picker anchors to a sidebar row, so a hidden sidebar comes back first.
    togglePicker: () => {
      setSidebarOpen(true);
      setPickerOpen((open) => !open);
    },
    newAgent: sheet.newAgent,
    newSession: () => void newSession(),
    closeTab: nav.closeTab,
    inTabs: nav.inTabs,
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
          onSelectSettings={openSettings}
          onCloseSettings={closePage}
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
            routinesOpen: isRoutines,
            onSelect: nav.openSession,
            onNewAgent: sheet.newAgent,
            onNewSession: () => void newSession(),
            onOpenRoutines: () => openRoutines(),
            onOpenSettings: () => openSettings(),
            onEdit: sheet.editAgent,
            onRename: (session, name) => void rename(session.id, name),
            onRemove: confirms.askSession,
            onRemoveMany: confirms.askSessions,
            onReorder: reorder,
          }}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <Pages
          page={page}
          workspaces={workspaces.workspaces}
          activeWorkspace={active}
          sessions={sessions}
          onConfirm={confirms.ask}
          onOpenHit={nav.openHit}
        />
        {/* Hidden, not unmounted: agent and terminal processes stay alive. */}
        <div hidden={!isWorkspace} className="flex min-h-0 flex-1 flex-col">
          <TabBar
            inset={!sidebarOpen}
            tabs={tabs.tabs}
            activeId={tabs.active?.id ?? null}
            sessions={sessions}
            onSelect={tabs.select}
            onClose={nav.closeTab}
            onLaunch={launch}
          />

          {workspaces.error && (
            <div className="border-b border-border px-3 py-2 text-danger">{workspaces.error}</div>
          )}

          <WorkspacePanes
            tab={tabs.active}
            panes={tabs.panes}
            workspaces={workspaces.workspaces}
            sessions={all}
            cwd={active?.path ?? null}
            hasWorkspace={active !== null}
            onCreateWorkspace={workspaces.create}
            onStatus={setStatus}
            onModel={changeModel}
            onOpenFile={nav.openFile}
            onOpenSession={nav.openSessionById}
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
          onOpenFile={nav.openFile}
          onOpenSession={nav.openSession}
          onSelectWorkspace={workspaces.activate}
          onClose={() => setPalette(null)}
        />
      )}

      <ConfirmDialog confirm={confirms.confirm} onClose={confirms.close} />

      <AgentSheetHost sheet={sheet} sessions={sessions} onNewRoutine={openRoutines} />
    </Sidebar.Provider>
    </AgentThemeProvider>
    </TerminalPrefsProvider>
  );
}
