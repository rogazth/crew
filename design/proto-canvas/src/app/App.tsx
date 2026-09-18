import { useEffect, useRef, useState } from "react";
import { matchesChord, type CommandId, type Tab } from "@crew/fixtures";
import { CommandPalette } from "@/chrome/CommandPalette";
import { ConfirmDialog } from "@/chrome/ConfirmDialog";
import { Drawer } from "@/chrome/Drawer";
import { Sidebar } from "@/chrome/Sidebar";
import { TabBar } from "@/chrome/TabBar";
import { Toaster } from "@/chrome/Toaster";
import { cx } from "@/lib/cx";
import { StoreProvider, useStore } from "@/lib/store";
import { AgentNetworkPage } from "@/surfaces/AgentNetwork";
import { ChatSurface } from "@/surfaces/chat";
import { FileEditor } from "@/surfaces/FileEditor";
import { RoutineEditor } from "@/surfaces/RoutineEditor";
import { RoutinesPage } from "@/surfaces/Routines";
import { SearchPage } from "@/surfaces/Search";
import { SettingsPage } from "@/surfaces/Settings";
import { TerminalSurface } from "@/surfaces/Terminal";
import { Empty } from "@/ui/Empty";
import { TooltipHost } from "@/ui/Tooltip";

export function App() {
  return (
    <StoreProvider>
      <TooltipHost>
        <Shell />
      </TooltipHost>
    </StoreProvider>
  );
}

function Shell() {
  const store = useStore();
  const { tabState, page, sidebarCollapsed } = store;
  useCommands();

  // A tab's surface is built the first time it is looked at and kept after
  // that. Mounting five transcripts at boot is the single most expensive thing
  // the shell can do, and nobody is reading four of them.
  const [mounted, setMounted] = useState<string[]>([]);
  const activeId = tabState.activeId;
  useEffect(() => {
    if (activeId) setMounted((held) => (held.includes(activeId) ? held : [...held, activeId]));
  }, [activeId]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-base text-ink">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <TabBar />
        <div className="relative flex min-h-0 flex-1 flex-col">
          {tabState.tabs
            .filter((tab) => tab.id === activeId || mounted.includes(tab.id))
            .map((tab) => (
              <div
                key={tab.id}
                className={cx(
                  "absolute inset-0 flex min-h-0 flex-col",
                  tab.id === activeId ? "" : "pointer-events-none invisible",
                )}
                aria-hidden={tab.id !== activeId}
              >
                <Surface tab={tab} />
              </div>
            ))}

          {tabState.tabs.length === 0 && (
            <div className="grid flex-1 place-items-center">
              <Empty
                icon="layers"
                title="No tabs open"
                description="Pick an agent in the sidebar, or press the command palette."
              />
            </div>
          )}

          {page && (
            <div className="enter-fade absolute inset-0 z-10 flex flex-col bg-base">
              {page.kind === "settings" && <SettingsPage section={page.section} />}
              {page.kind === "routines" && <RoutinesPage />}
              {page.kind === "routine" && <RoutineEditor id={page.id} />}
              {page.kind === "search" && <SearchPage />}
              {page.kind === "agents" && <AgentNetworkPage />}
            </div>
          )}
        </div>
      </main>

      {sidebarCollapsed && <span className="sr-only">Sidebar hidden</span>}
      <Drawer />
      <CommandPalette onCommand={(id) => runCommand(store, id)} />
      <ConfirmDialog />
      <Toaster />
    </div>
  );
}

function Surface({ tab }: { tab: Tab }) {
  const { sessionById } = useStore();
  if (tab.kind === "file") return <FileEditor relative={tab.relative} />;
  if (tab.kind === "stub") {
    if (tab.stub === "terminal") return <TerminalSurface sessionId="t-scratch" title="Terminal" />;
    return (
      <div className="grid flex-1 place-items-center">
        <Empty
          icon={tab.stub === "browser" ? "globe" : "bot"}
          title={tab.stub === "browser" ? "Browser" : "Side chat"}
          description="A placeholder surface. The real app hosts a webview here."
        />
      </div>
    );
  }
  const session = sessionById(tab.sessionId);
  if (!session) {
    return (
      <div className="grid flex-1 place-items-center">
        <Empty icon="circleAlert" title="That session is gone" description="It was deleted while the tab was open." />
      </div>
    );
  }
  if (session.kind === "terminal") return <TerminalSurface sessionId={session.id} title={session.name} />;
  return <ChatSurface sessionId={session.id} />;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Store = ReturnType<typeof useStore>;

function runCommand(store: Store, id: CommandId) {
  const { tabState, activeTab } = store;
  switch (id) {
    case "open-launcher":
      store.setLauncher(true);
      return;
    case "close":
      if (tabState.activeId) store.requestCloseTab(tabState.activeId);
      return;
    case "reopen-tab":
      store.reopenClosed();
      return;
    case "next-tab":
      store.stepTabs(1);
      return;
    case "prev-tab":
      store.stepTabs(-1);
      return;
    case "last-tab":
      store.gotoTab(-1);
      return;
    case "open-palette":
      store.setPalette("all");
      return;
    case "go-to-file":
      store.setPalette("files");
      return;
    case "open-actions":
      store.setPalette("actions");
      return;
    case "open-workspace":
    case "switch-workspace":
      store.setWsPicker(true);
      return;
    case "next-workspace":
      store.stepWorkspace(1);
      return;
    case "prev-workspace":
      store.stepWorkspace(-1);
      return;
    case "new-agent":
      store.setDrawer({ kind: "agent-sheet", mode: "create" });
      return;
    case "new-session":
      store.openStub("terminal", "Terminal");
      return;
    case "find-in-terminal":
      window.dispatchEvent(new CustomEvent("canvas:terminal", { detail: "find" }));
      return;
    case "zoom-in":
      store.setTerminalPrefs({ ...store.terminalPrefs, fontSize: Math.min(22, store.terminalPrefs.fontSize + 1) });
      return;
    case "zoom-out":
      store.setTerminalPrefs({ ...store.terminalPrefs, fontSize: Math.max(9, store.terminalPrefs.fontSize - 1) });
      return;
    case "zoom-reset":
      store.setTerminalPrefs({ ...store.terminalPrefs, fontSize: 13 });
      return;
    case "toggle-sidebar":
      store.toggleSidebar();
      return;
    case "toggle-theme":
      store.toggleTheme();
      return;
    case "open-routines":
      store.setPage({ kind: "routines" });
      return;
    case "search-messages":
      store.setPage({ kind: "search", query: "" });
      return;
    case "open-settings":
      store.setSidebarView("settings");
      store.setPage({ kind: "settings", section: "general" });
      return;
    case "save-file":
      if (activeTab?.kind === "file") store.saveFile(activeTab.relative);
      return;
    default: {
      const tab = /^tab-([1-8])$/.exec(id);
      if (tab) {
        store.gotoTab(Number(tab[1]) - 1);
        return;
      }
      const workspace = /^workspace-([1-9])$/.exec(id);
      if (workspace) {
        const target = store.workspaces[Number(workspace[1]) - 1];
        if (target) store.setWorkspaceId(target.id);
      }
    }
  }
}

function useCommands() {
  const store = useStore();
  // The store object is new on every render; the listener reads it through a ref
  // so the window binding is attached once instead of once a frame.
  const latest = useRef(store);
  latest.current = store;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current;
      if (event.key === "Escape" && current.selection.length > 0) {
        current.setSelection([]);
        return;
      }
      for (const id of COMMAND_LIST) {
        if (matchesChord(event, current.chordFor(id))) {
          event.preventDefault();
          runCommand(current, id);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Every binding the shell owns, in the order they are tested. */
const COMMAND_LIST: CommandId[] = [
  "open-launcher",
  "close",
  "reopen-tab",
  "next-tab",
  "prev-tab",
  "tab-1",
  "tab-2",
  "tab-3",
  "tab-4",
  "tab-5",
  "tab-6",
  "tab-7",
  "tab-8",
  "last-tab",
  "open-palette",
  "go-to-file",
  "open-actions",
  "open-workspace",
  "switch-workspace",
  "next-workspace",
  "prev-workspace",
  "workspace-1",
  "workspace-2",
  "workspace-3",
  "new-agent",
  "new-session",
  "find-in-terminal",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "toggle-sidebar",
  "toggle-theme",
  "open-routines",
  "search-messages",
  "open-settings",
  "save-file",
];
