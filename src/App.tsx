import { useCallback, useEffect, useMemo, useState } from "react";
import { BotSheetHost } from "./chrome/BotSheet";
import { CommandPalette, type PaletteMode } from "./chrome/CommandPalette";
import { MachineBanner } from "./chrome/MachineBanner";
import { MachinePalette } from "./chrome/MachinePalette";
import { ConfirmDialog } from "./chrome/ConfirmDialog";
import { NewWorktreeDialog } from "./chrome/NewWorktreeDialog";
import { ShortcutsDialog } from "./chrome/ShortcutsDialog";
import { SidebarToggle } from "./chrome/SidebarToggle";
import { LinkRouter } from "./chrome/LinkRouter";
import { AppSidebar } from "./chrome/AppSidebar";
import { TabBar } from "./chrome/TabBar";
import { Explorer } from "./chrome/explorer/Explorer";
import { useBotSheet } from "./hooks/useBotSheet";
import { useAppCommands } from "./hooks/useAppCommands";
import { useBlankSessions } from "./hooks/useBlankSessions";
import { showFolder } from "./hooks/useFileTree";
import { useBrowserBridge } from "./hooks/useBrowserBridge";
import { useKeyOverrides, useLoadKeybindings } from "./hooks/useKeybindings";
import { useSessionTitle } from "./hooks/useSessionTitle";
import { useConfirmations } from "./hooks/useConfirmations";
import { useEnvironments } from "./hooks/useEnvironments";
import { useExplorer } from "./hooks/useExplorer";
import { useLaunch } from "./hooks/useLaunch";
import { useNavigation } from "./hooks/useNavigation";
import { useNotificationTarget } from "./hooks/useNotificationTarget";
import { useMarkSeen } from "./hooks/useMarkSeen";
import { useDockBadge } from "./hooks/useDockBadge";
import { Toaster } from "./chrome/Toaster";
import { useExplorerRoot } from "./hooks/useExplorerRoot";
import { useProjectFiles } from "./hooks/useProjectFiles";
import { useSelectAllScope } from "./hooks/useSelectAllScope";
import { useSessions } from "./hooks/useSessions";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { BotAvatarProvider } from "./hooks/useBotAvatar";
import { BrowserPrefsProvider } from "./hooks/useBrowserPrefs";
import { TerminalPrefsProvider } from "./hooks/useTerminalPrefs";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useWorkContext } from "./hooks/useWorkContext";
import * as api from "./lib/api";
import { peekUnsent } from "./lib/firstPrompt";
import { zoomApp } from "./lib/host";
import { isTerminalTab, tabFile } from "./lib/tabs";
import { worktreeLabel, worktreeOf } from "./lib/worktrees";
import { Pages } from "./surfaces/Pages";
import { usePages } from "./hooks/usePages";
import { useProcesses } from "./hooks/useProcesses";
import { awaitsUser, isOrphan, liveRuns, startableIn } from "./lib/processes";
import { ProcessTab } from "./surfaces/ProcessTab";
import { CommandsView, type Place } from "./surfaces/CommandsView";
import { boot } from "./lib/turnRuntime";
import { unlockNotificationAudio } from "./lib/notificationSound";
import { watchProcesses } from "./lib/processAlerts";
import { WorkspacePanes } from "./surfaces/WorkspacePanes";
import { HomeStart } from "./surfaces/HomeStart";
import { HomeActions, TourFoot } from "./chrome/HomePanel";
import { useTour } from "./hooks/useTour";
import { useUpdateWiring } from "./hooks/useUpdate";
import type { Process } from "./lib/processes";
import { PanePlaceContext } from "./surfaces/chat/panePlace";
import { WorkspaceStart, focusWorkspaceStart } from "./surfaces/WorkspaceStart";
import type { AgentChoice } from "./lib/providers";

/** Until the workspace's commands have loaded: one list, so the chats do not redraw. */
const NO_PROCESSES: Process[] = [];

/**
 * Pages take over the main area; only settings swaps the sidebar too. They stack over
 * the tabs, so anything that opens or picks a tab has to leave the page first.
 */
export function App() {
  // The daemon runs turns whether or not anyone asked for one — a routine comes
  // due, a bot writes to another — so the window listens from the moment it
  // opens rather than from the first thing the user sends.
  useEffect(() => void boot(), []);
  useEffect(unlockNotificationAudio, []);
  useSelectAllScope();
  useBrowserBridge();
  useLoadKeybindings();
  // Hints that print a chord read it as they render; a rebind redraws them.
  useKeyOverrides();

  const workspaces = useWorkspaces();
  const sidebar = useSidebarWidth();
  const explorerWidth = useSidebarWidth("explorer:width", 280);
  const active = workspaces.active;
  const workspaceId = active?.id ?? null;
  const explorer = useExplorer(workspaceId);
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
  const { blank, markBlank } = useBlankSessions(all);
  const listed = useMemo(() => sessions.filter((session) => !blank.has(session.id)), [blank, sessions]);
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
  // The explorer's own pick of worktree: it holds until the tab on screen moves to another.
  const [explorerRoot, setExplorerRoot] = useExplorerRoot(active?.id ?? null, treePath);

  // Its panes go first: dropping them ends its shells. Its sessions' CLIs,
  // tabs open or closed, crewd ends with the workspace.
  const { dropWorkspace: forgetTabs } = tabs;
  const { remove: deleteWorkspace } = workspaces;
  const { forget: forgetExplorer } = explorer;
  const removeWorkspace = useCallback(
    async (id: string) => {
      forgetTabs(id);
      forgetSessions(id);
      await deleteWorkspace(id);
      forgetExplorer(id);
    },
    [deleteWorkspace, forgetExplorer, forgetSessions, forgetTabs],
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

  const workspaceIds = useMemo(() => workspaces.workspaces.map((workspace) => workspace.id), [workspaces.workspaces]);
  useEffect(() => watchProcesses(workspaceIds), [workspaceIds]);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [dialog, setDialog] = useState<"new-worktree" | "shortcuts" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The workspace whose name the rail asked to rename, until the sidebar settles it.
  const [renameWanted, setRenameWanted] = useState<string | null>(null);
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
  useUpdateWiring(openSettings);
  // Settings lives in the sidebar, so opening it opens the sidebar; leaving puts back a closed one.
  // Adjusted while rendering, on the page opening or closing, not on a toggle while it is open.
  const settingsOpen = settings !== null;
  const [settingsWas, setSettingsWas] = useState({ open: false, sidebarClosed: false });
  if (settingsOpen !== settingsWas.open) {
    setSettingsWas({ open: settingsOpen, sidebarClosed: settingsOpen && !sidebarOpen });
    if (settingsOpen) setSidebarOpen(true);
    else if (settingsWas.sidebarClosed) setSidebarOpen(false);
  }
  const processes = useProcesses(workspaceId);

  // With only the main checkout there is no other worktree to tell apart.
  const { tabPlaceOf } = work;

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
      })),
    [worktrees.list],
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
  const here = places.find((place) => place.worktree === work.placeIn) ?? places[0] ?? { worktree: null, label: "main" };
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
  const sheet = useBotSheet({ create, update, openSession: nav.openSession });
  const envs = useEnvironments({ workspaces, active, closePage, openSettings, openTerminalIn: nav.openTerminalIn });

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
  useMarkSeen(all, isWorkspace && tabs.active?.kind === "session" ? tabs.active.sessionId : null);

  // The worktree the sidebar's + asked the start screen to start in, until it is used or the sidebar moves on.
  const [startIn, setStartIn] = useState<string | null>(null);
  useEffect(() => setStartIn(null), [work.current?.path, active?.id]);
  const { newSession, startSession, launch } = useLaunch({
    worktree: work.placeIn,
    create,
    markBlank,
    openSession: nav.openSession,
    openStub: nav.openStub,
    openTerminal: nav.openTerminal,
    openBrowser: (url, incognito) => nav.openBrowser(url, incognito),
    openExplorer: () => {
      closePage();
      explorer.setMode("files");
    },
    newBot: sheet.newBot,
    showStart: (place) => {
      closePage();
      setStartIn(place ?? null);
      tabs.select(null);
      // Already on screen, it does not mount again to take the focus.
      window.setTimeout(focusWorkspaceStart, 0);
    },
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
    newBot: () => sheet.newBot(),
    newSession: () => void newSession(),
    newBrowser: (incognito) => nav.openBrowser("", incognito),
    closeTab: nav.closeTab,
    inTabs: nav.inTabs,
    newWorktree: () => !isHome && setDialog("new-worktree"),
    toggleShortcuts: () => setDialog((open) => (open === "shortcuts" ? null : "shortcuts")),
    openWorkspace: envs.openWorkspace,
    openHistory: () => nav.openStub("history", "History"),
    openCommands,
    startAllCommands: startableIn(processes.processes ?? [], here.worktree).length > 0 ? () => void processes.startAll(here.worktree) : null,
    stopAllCommands: commandCounts.live > 0 ? () => void processes.stopAll() : null,
    zoom: tabs.active?.kind === "browser" || isTerminalTab(tabs.active) ? null : (delta) => void zoomApp(delta),
  });

  if (workspaces.loading || sidebar.width === null) return <div className="h-full" />;

  const activeSessionId = tabs.active?.kind === "session" ? tabs.active.sessionId : null;
  const openPalette = (mode: PaletteMode) => setPalette(mode);

  // The content's worktree line, which can still move a session nobody has written to.
  const paneTab = tabs.active;
  const paneSession = paneTab?.kind === "session" ? all.find((s) => s.id === paneTab.sessionId) : undefined;
  const paneFresh = paneSession?.kind === "terminal" && !paneSession.providerSessionId && !paneSession.cursor;
  const panePath = paneTab && tabPlaceOf ? tabPlaceOf(paneTab) : null;
  const panePlaces = worktrees.list.map((tree) => ({ path: tree.path, label: worktreeLabel(tree) }));
  const panePlace = panePlaces.find((p) => p.path === panePath) ?? null;
  const paneMove =
    paneFresh && paneTab && paneSession
      ? (path: string) =>
          void newSession(
            {
              provider: paneSession.provider as AgentChoice["provider"],
              model: paneSession.model,
              effort: paneSession.effort as AgentChoice["effort"],
              access: paneSession.autonomy,
              ...(paneSession.serviceTier ? { serviceTier: paneSession.serviceTier } : {}),
            },
            path === active?.path ? null : path,
            undefined,
            undefined,
            peekUnsent(paneSession.id),
          ).then(async (moved) => {
            if (!moved) return;
            // The new one takes the old one's place and, once it is gone, its name.
            nav.closeTab(paneTab.id);
            await api.deleteSession(paneSession.id).catch(() => {});
            void rename(moved.id, paneSession.name);
          })
      : null;

  // The fresh session on screen can start in another worktree; its first screen says so and offers it.
  const panePick =
    paneMove && panePlace && paneSession ? { sessionId: paneSession.id, place: panePlace, places: panePlaces, onMove: paneMove } : null;

  return (
    <TerminalPrefsProvider>
    <BrowserPrefsProvider>
    <LinkRouter open={nav.openBrowser} />
    <Toaster onOpen={openNotified} />
    <BotAvatarProvider>
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
              setRenameWanted(null);
              workspaces.activate(id);
            },
            onCreate: envs.openWorkspace,
            remoteOf: envs.remoteOf,
            onRename: workspaces.rename,
            onRequestRename: setRenameWanted,
            onRemove: (workspace) => confirms.askWorkspace(workspace, tabs.unsavedIn(workspace.id)),
            onReorder: workspaces.reorder,
            onOpenRoutines: () => togglePage({ kind: "routines", draft: null }),
            onOpenSettings: () => (settings ? closePage() : openSettings()),
            onOpenUsage: () => openSettings("usage"),
          }}
          sessions={{
            workspace: active,
            worktrees: worktrees.list,
            sessions: listed,
            activeSessionId,
            onSelect: nav.openSession,
            // The main checkout is stored as null, so it asks for no worktree.
            onNewBot: (path) => sheet.newBot(path === undefined || path === active.path ? undefined : path),
            currentWorktree: work.current?.path ?? null,
            onSelectWorktree: work.selectWorktree,
            // A worktree's own menu passes its path; the main checkout is stored as null.
            onNewSession: (path) => startSession(undefined, path),
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
            onEdit: sheet.editBot,
            onRename: (session, name) => void rename(session.id, name),
            onRemove: confirms.askSession,
            onRemoveMany: confirms.askSessions,
            onReorder: reorder,
            home: isHome
              ? {
                  actions: (
                    <HomeActions
                      onNewSession={() => startSession()}
                      onNewBot={() => sheet.newBot()}
                      onOpenFolder={envs.openWorkspace}
                    />
                  ),
                  foot: tour.shown ? <TourFoot steps={tour.steps} onDismiss={tour.dismiss} /> : null,
                }
              : undefined,
            running: commandCounts.running,
            onRenameWorkspace: (name) => void workspaces.rename(active.id, name),
            renameWanted,
            onRenameSettled: () => setRenameWanted(null),
            onRemoveWorkspace: () => confirms.askWorkspace(active, tabs.unsavedIn(active.id)),
            commands: {
              live: commandCounts.live,
              asking: commandCounts.asking,
              orphans: commandCounts.orphans,
              open: isWorkspace && commandsOpen,
              onToggle: openCommands,
            },
            // A refusal from either still lets the other land; the button stops spinning either way.
            onRefresh: () => Promise.allSettled([worktrees.reread(), reloadSessions()]).then(() => {}),
          }}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-sidebar">
        <Pages
          page={page}
          workspaces={workspaces.workspaces}
          activeWorkspace={active}
          sessions={sessions}
          onConfirm={confirms.ask}
          onOpenTerminal={envs.openTerminalOn}
        />
        {/* Hidden, not unmounted: bot and terminal processes stay alive. */}
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
            onEditSession={sheet.editBot}
            onReorder={tabs.reorder}
            onPin={tabs.pin}
            onUnpin={tabs.unpin}
            onLaunch={launch}
            context={{
              workspace: isHome ? "Home" : (active?.name ?? ""),
              // The worktree on screen, by its real branch; a checkout with no branch names none.
              branch: isHome || !work.current || (work.current.main && !work.current.branch) ? "" : worktreeLabel(work.current),
              onSwitch: () => openPalette("context"),
            }}
            groups={null}
            branchOfSession={(session) => {
              if (!active || session.workspaceId !== active.id) return null;
              const tree = worktreeOf(session, active, worktrees.list);
              return tree && !(tree.main && !tree.branch) ? worktreeLabel(tree) : null;
            }}
            onDropFiles={openDropped}
          />


          <MachineBanner workspaceId={workspaceId} />

          {workspaces.error && (
            <div className="border-b border-border px-3 py-2 text-danger">{workspaces.error}</div>
          )}

          <div data-sheet="workspace" className="flex min-h-0 flex-1">
            {/* The content, not the tab, says its worktree. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PanePlaceContext value={panePick}>
            <WorkspacePanes
              tab={tabs.active}
              empty={
                isHome ? (
                  <HomeStart
                    firstRun={workspaces.projects.length === 0}
                    cwd={active?.path ?? null}
                    onAsk={(text, choice, files) => void newSession(choice, null, text, files)}
                    onOpenFolder={envs.openWorkspace}
                    onNewBot={() => sheet.newBot()}
                    onOpenBrowser={() => nav.openBrowser("")}
                  />
                ) : active ? (
                  <WorkspaceStart
                    key={active.id}
                    workspaceId={active.id}
                    places={panePlaces}
                    defaultPath={startIn ?? work.placeIn ?? active.path}
                    onPlace={(path) => {
                      setStartIn(null);
                      worktrees.select(path);
                    }}
                    onAsk={(text, choice, path, files) => {
                      setStartIn(null);
                      void newSession(choice, path === active.path ? null : path, text, files);
                    }}
                    onNewBot={() => sheet.newBot()}
                    onOpenFile={() => openPalette("files")}
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
              onOpenFile={nav.openFile}
              onOpenFolder={(path) => {
                if (!treePath || !path.startsWith(`${treePath}/`)) return;
                closePage();
                explorer.setMode("files");
                void showFolder(treePath, path);
              }}
              onOpenFileInBrowser={nav.openFileInBrowser}
              onOpenSession={nav.openSessionById}
              onPatchBrowser={tabs.patchBrowser}
              onClearTerminalInput={tabs.clearInput}
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
              processes={processes.processes ?? NO_PROCESSES}
              onOpenProcessRun={nav.openProcessRun}
              onOpenSignIn={nav.openSignIn}
              onOpenLogin={nav.openLogin}
            />
            </PanePlaceContext>
            </div>
            {explorer.open && explorerRoot && explorerWidth.width !== null && (
              <Explorer
                root={explorerRoot}
                width={explorerWidth.width}
                onResize={explorerWidth.resize}
                focus={explorer.focus}
                active={tabFile(tabs.active)?.path ?? null}
                onOpenFile={nav.openFile}
                places={worktrees.list.map((tree) => ({ path: tree.path, label: worktreeLabel(tree) }))}
                onRoot={setExplorerRoot}
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
          onOpenFile={nav.openFile}
          onOpenSession={nav.openSession}
          onSelectWorkspace={(id) => {
            closePage();
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
          onCreate={async (branch, withBot) => {
            const tree = await worktrees.create(branch);
            setDialog(null);
            closePage();
            if (withBot) sheet.newBot(tree.path);
          }}
        />
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}

      <SidebarToggle onClick={() => setSidebarOpen((open) => !open)} />

      <ConfirmDialog confirm={confirms.confirm} onAsk={confirms.ask} onClose={confirms.close} />


      <BotSheetHost
        sheet={sheet}
        sessions={sessions}
        onNewRoutine={openRoutines}
      />
    </div>
    </BotAvatarProvider>
    </BrowserPrefsProvider>
    </TerminalPrefsProvider>
  );
}

/** What ⌘⇧F starts from: the text selected on one line, as VS Code does. */
function selectedLine(): string | undefined {
  const text = window.getSelection()?.toString() ?? "";
  return text.trim() !== "" && !text.includes("\n") && text.length <= 200 ? text : undefined;
}
