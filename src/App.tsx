import { Sidebar } from "@cloudflare/kumo";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { AgentSheetHost } from "./chrome/AgentSheet";
import { CommandPalette, type PaletteMode } from "./chrome/CommandPalette";
import { ConfirmDialog } from "./chrome/ConfirmDialog";
import { NewWorktreeDialog } from "./chrome/NewWorktreeDialog";
import { ShortcutsDialog } from "./chrome/ShortcutsDialog";
import { SidebarToggle } from "./chrome/SidebarToggle";
import { LinkRouter } from "./chrome/LinkRouter";
import { AppSidebar } from "./chrome/AppSidebar";
import { TabBar } from "./chrome/TabBar";
import { UpdateDialog } from "./chrome/UpdateDialog";
import { useAgentSheet } from "./hooks/useAgentSheet";
import { useAppCommands } from "./hooks/useAppCommands";
import { useBrowserBridge } from "./hooks/useBrowserBridge";
import { useSessionTitle } from "./hooks/useSessionTitle";
import { useConfirmations } from "./hooks/useConfirmations";
import { useLaunch } from "./hooks/useLaunch";
import { useNavigation } from "./hooks/useNavigation";
import { useProjectFiles } from "./hooks/useProjectFiles";
import { useSelectAllScope } from "./hooks/useSelectAllScope";
import { useSessions } from "./hooks/useSessions";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { AgentAvatarProvider } from "./hooks/useAgentAvatar";
import { AgentThemeProvider } from "./hooks/useAgentTheme";
import { BrowserPrefsProvider } from "./hooks/useBrowserPrefs";
import { TerminalPrefsProvider } from "./hooks/useTerminalPrefs";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useWorkContext } from "./hooks/useWorkContext";
import { focusSidebar } from "./hooks/useSpatialKeys";
import * as api from "./lib/api";
import type { Session } from "./lib/types";
import { shortBranch, worktreeLabel } from "./lib/worktrees";
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
  useBrowserBridge();

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
    forget,
    reorder,
    setStatus,
    dropWorkspace: forgetSessions,
  } = useSessions(workspaceId);
  // Every workspace's: their terminals keep running, and renaming, out of sight.
  useSessionTitle(all, adoptName);
  const work = useWorkContext(active, sessions);
  const { tabs, worktrees, current } = work;
  const treePath = current?.path ?? active?.path ?? null;
  const files = useProjectFiles(treePath);

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

  // The daemon deletes its sessions with it; the strip it had goes the way a
  // workspace's does, once the daemon has said yes: a refusal keeps both.
  const removeWorktree = useCallback(
    async (tree: NonNullable<typeof current>, force: boolean) => {
      const gone = sessions.filter((session) => work.pathOf(session) === tree.path).map((session) => session.id);
      await worktrees.remove(tree, force);
      if (active) forgetTabs(`${active.id}@${tree.path}`);
      await forget(gone);
    },
    [active, forget, forgetTabs, sessions, work, worktrees],
  );

  const confirms = useConfirmations({
    closeTabsFor: tabs.closeForSession,
    removeSession: remove,
    removeWorkspace,
    removeWorktree,
    rereadWorktrees: worktrees.reread,
  });

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [dialog, setDialog] = useState<"new-worktree" | "shortcuts" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Destructured: the hook returns a fresh object each render, and these
  // callbacks are dependencies of half the shell.
  const { page, settings, isWorkspace, isRoutines, close: closePage, toggle: togglePage, openSettings, openRoutines } = usePages();

  const nav = useNavigation({ tabs, sessions, confirms, removeSession: remove, closePage, route: work.route });
  const sheet = useAgentSheet({ create, update, openSession: nav.openSession, createWorktree: worktrees.create });
  const { newSession, launch } = useLaunch({
    sessions,
    worktree: work.placeIn,
    create,
    openSession: nav.openSession,
    openStub: nav.openStub,
    openBrowser: (url) => nav.openBrowser(url),
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
    // A hidden sidebar comes back first; the focus waits for it to paint.
    focusSidebar: (scope) => {
      setSidebarOpen(true);
      requestAnimationFrame(() => focusSidebar(scope));
    },
    newAgent: () => sheet.newAgent(),
    newSession: () => void newSession(),
    closeTab: nav.closeTab,
    inTabs: nav.inTabs,
    worktrees: work,
    newWorktree: () => setDialog("new-worktree"),
    toggleShortcuts: () => setDialog((open) => (open === "shortcuts" ? null : "shortcuts")),
  });

  if (workspaces.loading || sidebar.width === null) return <div className="h-full" />;

  const activeSessionId = tabs.active?.kind === "session" ? tabs.active.sessionId : null;
  const openPalette = (mode: PaletteMode) => setPalette(mode);

  return (
    <TerminalPrefsProvider>
    <BrowserPrefsProvider>
    <LinkRouter open={nav.openBrowser} />
    <AgentThemeProvider>
    <AgentAvatarProvider>
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
          rail={{
            workspaces: workspaces.workspaces,
            activeId: active.id,
            sessions: all,
            settingsOpen: settings !== null,
            routinesOpen: isRoutines,
            // Picking a workspace is going back to it, out from under any page.
            onSelect: (id) => {
              closePage();
              workspaces.activate(id);
            },
            onCreate: workspaces.create,
            onRename: workspaces.rename,
            onRemove: confirms.askWorkspace,
            onReorder: workspaces.reorder,
            onOpenRoutines: () => togglePage({ kind: "routines", draft: null }),
            onOpenSettings: () => (settings ? closePage() : openSettings()),
          }}
          sessions={{
            workspace: active,
            worktrees: worktrees.list,
            activeWorktree: current?.path ?? active.path,
            sessions,
            activeSessionId,
            onSelect: nav.openSession,
            onSelectWorktree: (path) => {
              closePage();
              work.selectWorktree(path);
            },
            onNewAgent: sheet.newAgent,
            // A worktree's own menu passes its path; the main checkout is stored as null.
            onNewSession: (path) =>
              void newSession(undefined, path === undefined ? work.placeIn : path === active.path ? null : path),
            onToggleNotifications: (session) => void update(session.id, { ...session, notifications: !session.notifications }),
            onMarkRead: (session) => {
              void api.markSessionRead(session.id).catch(() => {});
              setStatus(session.id, "idle");
            },
            onNewWorktree: () => setDialog("new-worktree"),
            onRemoveWorktree: (tree) =>
              confirms.askWorktree(tree, sessions.filter((session) => work.pathOf(session) === tree.path)),
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
          onOpenUrl={nav.openUrl}
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
            onCloseMany={nav.closeTabs}
            onReopen={tabs.reopen}
            onEditSession={sheet.editAgent}
            onReorder={tabs.reorder}
            onLaunch={launch}
            context={{
              workspace: active?.name ?? "",
              branch: current ? worktreeLabel(current) : "",
              onSwitch: () => openPalette("context"),
            }}
            branchOf={
              work.scope === "all" && active
                ? (tab) => {
                    const session = tab.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined;
                    const tree = session && worktrees.list.find((t) => t.path === work.pathOf(session));
                    return tree ? { label: shortBranch(tree), hue: work.hues.get(tree.path) ?? 0 } : null;
                  }
                : null
            }
          />


          {workspaces.error && (
            <div className="border-b border-border px-3 py-2 text-danger">{workspaces.error}</div>
          )}

          <WorkspacePanes
            tab={tabs.active}
            panes={tabs.panes}
            workspaces={workspaces.workspaces}
            sessions={all}
            cwd={treePath}
            hasWorkspace={active !== null}
            onCreateWorkspace={workspaces.create}
            onStatus={setStatus}
            onModel={changeModel}
            onOpenFile={nav.openFile}
            onOpenSession={nav.openSessionById}
            onPatchBrowser={tabs.patchBrowser}
            onOpenBrowserTab={tabs.openIn}
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
          worktrees={worktrees.list}
          activeWorktree={current?.path ?? active.path}
          onOpenFile={nav.openFile}
          onOpenSession={nav.openSession}
          onSelectWorkspace={(id) => {
            closePage();
            workspaces.activate(id);
          }}
          onSelectWorktree={(id, path) => {
            closePage();
            if (id === active.id) return work.selectWorktree(path);
            worktrees.select(path, id);
            workspaces.activate(id);
          }}
          onClose={() => setPalette(null)}
        />
      )}

      {dialog === "new-worktree" && active && (
        <NewWorktreeDialog
          workspace={active}
          from={worktrees.list.find((tree) => tree.main)}
          onClose={() => setDialog(null)}
          onCreate={async (branch, withAgent) => {
            const tree = await worktrees.create(branch);
            setDialog(null);
            closePage();
            if (withAgent) sheet.newAgent(tree.path);
          }}
        />
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}

      <SidebarToggle onClick={() => setSidebarOpen((open) => !open)} />

      <ConfirmDialog confirm={confirms.confirm} onAsk={confirms.ask} onClose={confirms.close} />

      <UpdateDialog />

      <AgentSheetHost
        sheet={sheet}
        sessions={sessions}
        worktrees={worktrees.list}
        activeWorktree={work.placeIn}
        onNewRoutine={openRoutines}
      />
    </Sidebar.Provider>
    </AgentAvatarProvider>
    </AgentThemeProvider>
    </BrowserPrefsProvider>
    </TerminalPrefsProvider>
  );
}
