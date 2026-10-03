import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentSheetHost } from "./chrome/AgentSheet";
import { CommandPalette, type PaletteMode } from "./chrome/CommandPalette";
import { MachineBanner } from "./chrome/MachineBanner";
import { MachinePalette } from "./chrome/MachinePalette";
import { ConfirmDialog } from "./chrome/ConfirmDialog";
import { NewWorktreeDialog } from "./chrome/NewWorktreeDialog";
import { ShortcutsDialog } from "./chrome/ShortcutsDialog";
import { SidebarToggle } from "./chrome/SidebarToggle";
import { LinkRouter } from "./chrome/LinkRouter";
import { AppSidebar } from "./chrome/AppSidebar";
import { TabBar, type TabGroups } from "./chrome/TabBar";
import { UpdateDialog } from "./chrome/UpdateDialog";
import { Explorer } from "./chrome/explorer/Explorer";
import { useAgentSheet } from "./hooks/useAgentSheet";
import { useAppCommands } from "./hooks/useAppCommands";
import { useBrowserBridge } from "./hooks/useBrowserBridge";
import { useSessionTitle } from "./hooks/useSessionTitle";
import { useConfirmations } from "./hooks/useConfirmations";
import { useEnvironments } from "./hooks/useEnvironments";
import { useExplorer } from "./hooks/useExplorer";
import { useLaunch } from "./hooks/useLaunch";
import { useNavigation } from "./hooks/useNavigation";
import { useNotificationTarget } from "./hooks/useNotificationTarget";
import { useDockBadge } from "./hooks/useDockBadge";
import { Toaster } from "./chrome/Toaster";
import { useProjectFiles } from "./hooks/useProjectFiles";
import { useSelectAllScope } from "./hooks/useSelectAllScope";
import { useSessions } from "./hooks/useSessions";
import { useSessionView } from "./hooks/useSessionView";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { AgentAvatarProvider } from "./hooks/useAgentAvatar";
import { BrowserPrefsProvider } from "./hooks/useBrowserPrefs";
import { TerminalPrefsProvider } from "./hooks/useTerminalPrefs";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useWorkContext } from "./hooks/useWorkContext";
import * as api from "./lib/api";
import { zoomApp } from "./lib/host";
import { markStopped, useRunningSessions } from "./lib/runningSessions";
import { isTerminalTab, sessionPtyId, tabFile } from "./lib/tabs";
import type { Session } from "./lib/types";
import { worktreeLabel } from "./lib/worktrees";
import { Pages } from "./surfaces/Pages";
import { usePages } from "./hooks/usePages";
import { useProcesses } from "./hooks/useProcesses";
import { CommandsButton } from "./chrome/CommandsButton";
import { awaitsUser, isOrphan, liveRuns, startableIn } from "./lib/processes";
import { ProcessTab } from "./surfaces/ProcessTab";
import { CommandsView, type Place } from "./surfaces/CommandsView";
import { boot } from "./lib/agentRuntime";
import { unlockNotificationAudio } from "./lib/notificationSound";
import { WorkspacePanes } from "./surfaces/WorkspacePanes";
import { HomeStart } from "./surfaces/HomeStart";
import { HomeActions, TourFoot } from "./chrome/HomePanel";
import { useTour } from "./hooks/useTour";

/**
 * Pages take over the main area; only settings swaps the sidebar too. They stack over
 * the tabs, so anything that opens or picks a tab has to leave the page first.
 */
export function App() {
  // The daemon runs turns whether or not anyone asked for one — a routine comes
  // due, an agent writes to another — so the window listens from the moment it
  // opens rather than from the first thing the user sends.
  useEffect(() => void boot(), []);
  useEffect(unlockNotificationAudio, []);
  useSelectAllScope();
  useBrowserBridge();

  const workspaces = useWorkspaces();
  const sidebar = useSidebarWidth();
  const explorer = useExplorer();
  const explorerWidth = useSidebarWidth("explorer:width", 280);
  const active = workspaces.active;
  const workspaceId = active?.id ?? null;
  // Home is a workspace with no project: one folder, no git, its own panel and start page.
  const isHome = active?.home === true;
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
    reload: reloadSessions,
  } = useSessions(workspaceId);
  const { surfaceOf } = useSessionView();
  // Every workspace's: their terminals keep running, and renaming, out of sight.
  useSessionTitle(all, adoptName);
  const work = useWorkContext(active, sessions, { workspaces: workspaces.workspaces, sessions: all });
  const { tabs, worktrees, current } = work;
  const tour = useTour(workspaces.home, workspaces.projects, all);
  // A page opened anywhere ticks the tour's last step.
  const { triedBrowser } = tour;
  const openedPage = tabs.tabs.some((tab) => tab.kind === "browser");
  useEffect(() => {
    if (openedPage) triedBrowser();
  }, [openedPage, triedBrowser]);
  const treePath = current?.path ?? active?.path ?? null;
  const files = useProjectFiles(treePath);

  // Its panes go first: dropping them ends its shells. Its sessions' CLIs,
  // tabs open or closed, crewd ends with the workspace.
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

  // A closed tab leaves its CLI running; Stop is what ends it. Its tabs go with
  // it: the session stays in the sidebar, and opening it starts the CLI again.
  const workspaceIds = useMemo(() => workspaces.workspaces.map((workspace) => workspace.id), [workspaces.workspaces]);
  const runningSessions = useRunningSessions(workspaceIds);
  const { askStop } = confirms;
  const { closeForSession } = tabs;
  const stopSession = useCallback(
    (session: Session) =>
      askStop(session, () => {
        closeForSession(session.id);
        markStopped(session.id);
        // A crewd from before Stop knows the terminal by its id alone.
        void api.stopSession(session.id).catch(() => api.killPty(sessionPtyId(session.workspaceId, session.id)));
      }),
    [askStop, closeForSession],
  );

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [dialog, setDialog] = useState<"new-worktree" | "shortcuts" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Destructured: the hook returns a fresh object each render, and these
  // callbacks are dependencies of half the shell.
  const {
    page,
    settings,
    isWorkspace,
    isRoutines,
    close: closePage,
    toggle: togglePage,
    openSettings,
    openRoutines,
  } = usePages();
  const processes = useProcesses(workspaceId);

  // With only the main checkout there is no other worktree to tell apart.
  const { tabPlaceOf, hues } = work;
  const branches = useMemo(
    () => new Map(worktrees.list.map((tree) => [tree.path, { label: worktreeLabel(tree), hue: hues.get(tree.path) ?? 0 }])),
    [hues, worktrees.list],
  );
  const { collapsed, collapse, collapseOther, expand } = tabs;
  const groups = useMemo<TabGroups | null>(
    () =>
      tabPlaceOf && {
        placeOf: tabPlaceOf,
        labelOf: (place) => branches.get(place) ?? null,
        collapsed,
        onCollapse: collapse,
        onCollapseOthers: collapseOther,
        onExpand: expand,
      },
    [branches, collapse, collapseOther, collapsed, expand, tabPlaceOf],
  );

  const nav = useNavigation({
    tabs,
    sessions,
    confirms,
    removeSession: remove,
    closePage,
    route: work.route,
    routeTo: work.routeTo,
    root: active?.path ?? null,
  });

  // Where each command can run, the main checkout first, and what runs where:
  // the sidebar marks a worktree with a server up, and counts what waits on the user.
  const places = useMemo<Place[]>(
    () =>
      worktrees.list.map((tree) => ({
        worktree: tree.main ? null : tree.path,
        label: worktreeLabel(tree),
        hue: hues.get(tree.path) ?? 0,
      })),
    [hues, worktrees.list],
  );
  const commandCounts = useMemo(() => {
    const list = processes.processes ?? [];
    const live = liveRuns(list);
    const alive = new Set(all.map((session) => session.id));
    const running = new Map<string, string[]>();
    for (const { process, run } of live) {
      const path = run.worktree ?? active?.path ?? "";
      running.set(path, [...(running.get(path) ?? []), process.name]);
    }
    return {
      running,
      live: live.length,
      orphans: live.filter(({ run }) => isOrphan(run, alive)).length,
      asking: list.filter(awaitsUser).length,
    };
  }, [active?.path, all, processes.processes]);
  // The worktree on screen: where a Commands tab opens, and where Start all starts.
  const here = places.find((place) => place.worktree === work.placeIn) ?? places[0] ?? { worktree: null, label: "main", hue: 0 };
  const { openStub } = nav;
  const openCommands = useCallback(() => openStub("commands", "Commands"), [openStub]);
  // A file dropped on the strip opens as ⌘P would open it: one in the worktree
  // keeps its path there, one from elsewhere resolves against its own folder.
  const { openFile } = nav;
  const openDropped = useCallback(
    (paths: string[]) => {
      for (const path of paths) {
        const name = path.split("/").pop() ?? path;
        const relative = treePath && path.startsWith(`${treePath}/`) ? path.slice(treePath.length + 1) : name;
        openFile({ path, relative, name });
      }
    },
    [openFile, treePath],
  );
  const commandsOpen = tabs.active?.kind === "stub" && tabs.active.stub === "commands";
  const sheet = useAgentSheet({ create, update, openSession: nav.openSession, createWorktree: worktrees.create });
  const envs = useEnvironments({ workspaces, active, closePage, openSettings, create, openSession: nav.openSession });

  const { activate } = workspaces;
  const openNotified = useNotificationTarget({
    sessions: all,
    activeWorkspaceId: workspaceId,
    visibleSessionId: isWorkspace && tabs.active?.kind === "session" ? tabs.active.sessionId : null,
    activate,
    openSession: nav.openSession,
    closePage,
  });

  useDockBadge(all);

  const { newSession, launch } = useLaunch({
    sessions,
    worktree: work.placeIn,
    create,
    openSession: nav.openSession,
    openStub: nav.openStub,
    openTerminal: nav.openTerminal,
    openBrowser: (url, incognito) => nav.openBrowser(url, incognito),
    newAgent: sheet.newAgent,
  });

  useAppCommands({
    workspaces,
    tabs,
    pages: { isWorkspace, close: closePage, toggle: togglePage, openSettings },
    palette,
    togglePalette: (mode: PaletteMode) => setPalette((open) => (open === mode ? null : mode)),
    closePalette: () => setPalette(null),
    sheetOpen: sheet.sheet !== null,
    closeSheet: sheet.close,
    toggleSidebar: () => setSidebarOpen((open) => !open),
    toggleExplorer: () => {
      closePage();
      explorer.toggle("files");
    },
    searchFiles: () => {
      closePage();
      explorer.toggle("search", selectedLine());
    },
    newAgent: () => sheet.newAgent(),
    newSession: () => void newSession(),
    newBrowser: (incognito) => nav.openBrowser("", incognito),
    closeTab: nav.closeTab,
    inTabs: nav.inTabs,
    worktrees: work,
    newWorktree: () => !isHome && setDialog("new-worktree"),
    toggleShortcuts: () => setDialog((open) => (open === "shortcuts" ? null : "shortcuts")),
    openWorkspace: envs.openWorkspace,
    openHistory: () => nav.openStub("history", "History"),
    openCommands,
    startAllCommands: startableIn(processes.processes ?? [], here.worktree).length > 0 ? () => void processes.startAll(here.worktree) : null,
    stopAllCommands: commandCounts.live > 0 ? () => void processes.stopAll() : null,
    zoom: tabs.active?.kind === "browser" || isTerminalTab(tabs.active, sessions, surfaceOf) ? null : (delta) => void zoomApp(delta),
  });

  if (workspaces.loading || sidebar.width === null) return <div className="h-full" />;

  const activeSessionId = tabs.active?.kind === "session" ? tabs.active.sessionId : null;
  const openPalette = (mode: PaletteMode) => setPalette(mode);

  return (
    <TerminalPrefsProvider>
    <BrowserPrefsProvider>
    <LinkRouter open={nav.openBrowser} />
    <Toaster onOpen={openNotified} />
    <AgentAvatarProvider>
    <div className="flex h-full">
      {active && (
        <AppSidebar
          open={sidebarOpen}
          width={sidebar.width}
          onResize={sidebar.resize}
          settings={settings}
          onSelectSettings={openSettings}
          onCloseSettings={closePage}
          rail={{
            workspaces: workspaces.projects,
            home: workspaces.home,
            activeId: active.id,
            sessions: all,
            settingsOpen: settings !== null,
            routinesOpen: isRoutines,
            // Picking a workspace is going back to it, out from under any page.
            onSelect: (id) => {
              closePage();
              workspaces.activate(id);
            },
            onCreate: envs.openWorkspace,
            remoteOf: envs.remoteOf,
            onRename: workspaces.rename,
            onRemove: (workspace) => confirms.askWorkspace(workspace, tabs.unsavedIn(workspace.id)),
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
              confirms.askWorktree(
                tree,
                sessions.filter((session) => work.pathOf(session) === tree.path),
                tabs.unsavedIn(`${active.id}@${tree.path}`),
                commandCounts.running.get(tree.path) ?? [],
              ),
            onEdit: sheet.editAgent,
            onRename: (session, name) => void rename(session.id, name),
            onRemove: confirms.askSession,
            onRemoveMany: confirms.askSessions,
            runningSessions,
            onStop: stopSession,
            onReorder: reorder,
            home: isHome
              ? {
                  actions: (
                    <HomeActions
                      onNewSession={() => void newSession()}
                      onNewAgent={() => sheet.newAgent()}
                      onOpenFolder={envs.openWorkspace}
                    />
                  ),
                  foot: tour.shown ? <TourFoot steps={tour.steps} onDismiss={tour.dismiss} /> : null,
                }
              : undefined,
            commands: isHome ? undefined : (
              <CommandsButton
                live={commandCounts.live}
                asking={commandCounts.asking}
                orphans={commandCounts.orphans}
                open={isWorkspace && commandsOpen}
                onToggle={openCommands}
              />
            ),
            running: commandCounts.running,
            // A refusal from either still lets the other land; the button stops spinning either way.
            onRefresh: () => Promise.allSettled([worktrees.reread(), reloadSessions()]).then(() => {}),
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
          onOpenTerminal={envs.openTerminalOn}
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
            runningSessions={runningSessions}
            onStopSession={stopSession}
            onReorder={tabs.reorder}
            onPin={tabs.pin}
            onUnpin={tabs.unpin}
            onLaunch={launch}
            context={{
              workspace: isHome ? "Home" : (active?.name ?? ""),
              branch: current && !isHome ? worktreeLabel(current) : "",
              onSwitch: () => openPalette("context"),
            }}
            groups={groups}
            onDropFiles={openDropped}
          />


          <MachineBanner workspaceId={workspaceId} />

          {workspaces.error && (
            <div className="border-b border-border px-3 py-2 text-danger">{workspaces.error}</div>
          )}

          <div className="flex min-h-0 flex-1">
            <WorkspacePanes
              tab={tabs.active}
              empty={
                isHome ? (
                  <HomeStart
                    firstRun={workspaces.projects.length === 0}
                    onAsk={(text, choice) => void newSession(choice, null, text)}
                    onOpenFolder={envs.openWorkspace}
                    onNewAgent={() => sheet.newAgent()}
                    onOpenBrowser={() => nav.openBrowser("")}
                  />
                ) : undefined
              }
              panes={tabs.panes}
              workspaces={workspaces.workspaces}
              sessions={all}
              placeOf={work.placeOf}
              cwd={treePath}
              hasWorkspace={active !== null}
              onCreateWorkspace={envs.openWorkspace}
              onStatus={setStatus}
              onOpenFile={nav.openFile}
              onOpenFileInBrowser={nav.openFileInBrowser}
              onOpenSession={nav.openSessionById}
              onPatchBrowser={tabs.patchBrowser}
              onOpenBrowserTab={tabs.openIn}
              onAdoptBrowserTab={tabs.adopt}
              files={files}
              onConfirm={confirms.ask}
              renderProcess={(tab) => (
                <ProcessTab
                  key={tab.id}
                  processId={tab.processId}
                  worktree={tab.worktree}
                  place={places.find((place) => place.worktree === tab.worktree)?.label ?? tab.worktree ?? "main"}
                  processes={processes}
                  onOpenCommands={openCommands}
                />
              )}
              renderCommands={() =>
                active && (
                  <CommandsView
                    key={active.id}
                    workspaceId={active.id}
                    processes={processes}
                    places={places}
                    here={here}
                    sessions={all}
                    onOpenRun={nav.openProcessRun}
                    onConfirm={confirms.ask}
                  />
                )
              }
              // Chrome's way: the entry loads where History was, so the tab turns into the page.
              onOpenHistory={(url) => {
                const history = tabs.active;
                nav.openBrowser(url);
                if (history?.kind === "stub" && history.stub === "history") tabs.close(history.id);
              }}
            />
            {explorer.open && treePath && explorerWidth.width !== null && (
              <Explorer
                root={treePath}
                width={explorerWidth.width}
                onResize={explorerWidth.resize}
                mode={explorer.mode}
                onMode={explorer.setMode}
                focus={explorer.focus}
                active={tabFile(tabs.active)?.path ?? null}
                onOpenFile={nav.openFile}
              />
            )}
          </div>
        </div>
      </main>

      {envs.picker && (
        <MachinePalette
          start={envs.picker.start}
          onClose={envs.closePicker}
          onThisMac={envs.openLocal}
          onAdd={envs.addMachine}
          onOpen={envs.openOn}
        />
      )}

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
            // Its tab is picked before the workspace shows, so the strip never flashes another.
            void work.selectWorktreeIn(id, path).catch(() => {}).finally(() => workspaces.activate(id));
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
    </div>
    </AgentAvatarProvider>
    </BrowserPrefsProvider>
    </TerminalPrefsProvider>
  );
}

/** What ⌘⇧F starts from: the text selected on one line, as VS Code does. */
function selectedLine(): string | undefined {
  const text = window.getSelection()?.toString() ?? "";
  return text.trim() !== "" && !text.includes("\n") && text.length <= 200 ? text : undefined;
}
