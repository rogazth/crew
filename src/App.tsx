import { Sidebar } from "@cloudflare/kumo";
import { useCallback, useState, type CSSProperties } from "react";
import { AgentSheet, type AgentDraft } from "./chrome/AgentSheet";
import { CommandPalette, type PaletteMode } from "./chrome/CommandPalette";
import { ConfirmDialog, type Confirm } from "./chrome/ConfirmDialog";
import { AppSidebar } from "./chrome/AppSidebar";
import { TabBar } from "./chrome/TabBar";
import type { Launch } from "./chrome/TabLauncher";
import { useCommands } from "./hooks/useCommand";
import { useProjectFiles } from "./hooks/useProjectFiles";
import { useSelectAllScope } from "./hooks/useSelectAllScope";
import { useSessions } from "./hooks/useSessions";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useTabs } from "./hooks/useTabs";
import { TerminalPrefsProvider } from "./hooks/useTerminalPrefs";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./lib/providers";
import { fileTabId, sessionTabId, stubTabId } from "./lib/tabs";
import type { ProjectFile, Session, StubKind, Workspace } from "./lib/types";
import { SETTINGS_DEFAULT, type SettingsSectionId } from "./lib/settings";
import { nextSessionName } from "./lib/workspaces";
import { Surface } from "./surfaces/Surface";
import { Terminals } from "./surfaces/Terminals";
import { SettingsView } from "./surfaces/SettingsView";

type Sheet = { session: Session | null };

export function App() {
  useSelectAllScope();

  const workspaces = useWorkspaces();
  const sidebar = useSidebarWidth();
  const active = workspaces.active;
  const { sessions, create, update, rename, remove, reorder } = useSessions(active?.id ?? null);
  const tabs = useTabs(active?.id ?? null);
  const files = useProjectFiles(active?.path ?? null);

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settings, setSettings] = useState<SettingsSectionId | null>(null);

  const openSession = useCallback(
    (session: Session) =>
      tabs.open({ id: sessionTabId(session.id), kind: "session", sessionId: session.id }),
    [tabs],
  );

  const openFile = useCallback(
    (file: ProjectFile) => {
      tabs.open({ id: fileTabId(file.path), kind: "file", path: file.path, relative: file.relative });
      setPalette(null);
    },
    [tabs],
  );

  // Sessions open straight away; the name is derived, never prompted.
  const newSession = useCallback(async () => {
    const session = await create("terminal", {
      name: nextSessionName(sessions, DEFAULT_PROVIDER),
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      description: "",
    });
    if (session) openSession(session);
  }, [create, openSession, sessions]);

  const newAgent = useCallback(() => setSheet({ session: null }), []);

  const openStub = useCallback(
    (stub: StubKind, title: string) =>
      tabs.open({ id: stubTabId(stub), kind: "stub", stub, title }),
    [tabs],
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
      if (editing) {
        await update(editing.id, draft);
      } else {
        const session = await create("agent", draft);
        if (session) openSession(session);
      }
    },
    [create, openSession, sheet, update],
  );

  const confirmRemoveSession = useCallback(
    (session: Session) =>
      setConfirm({
        title: `Delete ${session.kind === "agent" ? "agent" : "session"} "${session.name}"?`,
        description: "Its history is removed from this workspace. This cannot be undone.",
        action: "Delete",
        onConfirm: async () => {
          tabs.closeForSession(session.id);
          await remove(session.id);
        },
      }),
    [remove, tabs],
  );

  const confirmRemoveSessions = useCallback(
    (list: Session[]) => {
      const [only] = list;
      if (list.length === 1 && only) return confirmRemoveSession(only);
      setConfirm({
        title: `Delete ${list.length} items?`,
        description: "Their history is removed from this workspace. This cannot be undone.",
        action: "Delete",
        onConfirm: async () => {
          for (const session of list) {
            tabs.closeForSession(session.id);
            await remove(session.id);
          }
        },
      });
    },
    [confirmRemoveSession, remove, tabs],
  );

  const confirmRemoveWorkspace = useCallback(
    (workspace: Workspace) =>
      setConfirm({
        title: `Remove workspace "${workspace.name}"?`,
        description: "Agents and sessions inside it are deleted. Files on disk are untouched.",
        action: "Remove",
        onConfirm: () => workspaces.remove(workspace.id),
      }),
    [workspaces],
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
    "toggle-sidebar": () => setSidebarOpen((open) => !open),
    "new-agent": newAgent,
    "new-session": () => void newSession(),
    "open-settings": () => setSettings((open) => (open ? null : SETTINGS_DEFAULT)),
    "reopen-tab": tabs.reopen,
    "next-tab": () => tabs.step(1),
    "prev-tab": () => tabs.step(-1),
    "tab-1": () => tabs.activate(0),
    "tab-2": () => tabs.activate(1),
    "tab-3": () => tabs.activate(2),
    "tab-4": () => tabs.activate(3),
    "tab-5": () => tabs.activate(4),
    "tab-6": () => tabs.activate(5),
    "tab-7": () => tabs.activate(6),
    "tab-8": () => tabs.activate(7),
    "last-tab": () => tabs.activate(-1),
    close: () => {
      if (palette) setPalette(null);
      else if (sheet) setSheet(null);
      else if (settings) setSettings(null);
      else if (tabs.active) tabs.close(tabs.active.id);
    },
  });

  if (workspaces.loading || sidebar.width === null) return <div className="h-full" />;

  const activeSessionId = tabs.active?.kind === "session" ? tabs.active.sessionId : null;

  return (
    <TerminalPrefsProvider>
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
          onSelectSettings={setSettings}
          onCloseSettings={() => setSettings(null)}
          sessions={{
            workspace: active,
            workspaces: workspaces.workspaces,
            pickerOpen,
            onPickerOpenChange: setPickerOpen,
            onSelectWorkspace: workspaces.activate,
            onCreateWorkspace: workspaces.create,
            onRenameWorkspace: workspaces.rename,
            onRemoveWorkspace: confirmRemoveWorkspace,
            onReorderWorkspaces: workspaces.reorder,
            sessions,
            activeSessionId,
            settingsOpen: settings !== null,
            onSelect: openSession,
            onNewAgent: newAgent,
            onNewSession: newSession,
            onOpenSettings: () => setSettings(SETTINGS_DEFAULT),
            onEdit: (session) => setSheet({ session }),
            onRename: (session, name) => void rename(session.id, name),
            onRemove: confirmRemoveSession,
            onRemoveMany: confirmRemoveSessions,
            onReorder: reorder,
          }}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        {settings && <SettingsView section={settings} />}
        {/* Hidden, not unmounted: the terminals underneath keep their processes. */}
        <div hidden={settings !== null} className="flex min-h-0 flex-1 flex-col">
          <TabBar
            inset={!sidebarOpen}
            tabs={tabs.tabs}
            activeId={tabs.active?.id ?? null}
            sessions={sessions}
            onSelect={tabs.select}
            onClose={tabs.close}
            onLaunch={launch}
          />

          {workspaces.error && (
            <div className="border-b border-border px-3 py-2 text-danger">{workspaces.error}</div>
          )}

          <div className="relative min-h-0 flex-1">
            <Surface
              tab={tabs.active}
              sessions={sessions}
              hasWorkspace={active !== null}
              onCreateWorkspace={workspaces.create}
            />
            {active && (
              <Terminals
                tabs={tabs.tabs}
                activeId={tabs.active?.id ?? null}
                sessions={sessions}
                cwd={active.path}
              />
            )}
          </div>
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

      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />

      {sheet && (
        <AgentSheet
          session={sheet.session}
          existingNames={sessions.filter((s) => s.kind === "agent").map((s) => s.name)}
          onSave={saveSheet}
          onClose={() => setSheet(null)}
        />
      )}
    </Sidebar.Provider>
    </TerminalPrefsProvider>
  );
}
