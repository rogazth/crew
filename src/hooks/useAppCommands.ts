import type { PaletteMode } from "../chrome/CommandPalette";
import { SETTINGS_DEFAULT } from "../lib/settings";
import { useCommands } from "./useCommand";
import type { usePages } from "./usePages";
import type { useTabs } from "./useTabs";
import type { useWorkspaces } from "./useWorkspaces";

type Deps = {
  workspaces: ReturnType<typeof useWorkspaces>;
  tabs: ReturnType<typeof useTabs>;
  pages: Pick<ReturnType<typeof usePages>, "isWorkspace" | "close" | "toggle" | "openSettings">;
  palette: PaletteMode | null;
  togglePalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  sheetOpen: boolean;
  closeSheet: () => void;
  toggleSidebar: () => void;
  toggleExplorer: () => void;
  searchFiles: () => void;
  worktrees: { step: (delta: number) => void; selectAt: (index: number) => void };
  newWorktree: () => void;
  toggleShortcuts: () => void;
  /** History is a tab, beside the pages it lists. */
  openHistory: () => void;
  /** Commands are a tab too, in the strip on screen. */
  openCommands: () => void;
  /** Null while there is nothing to start, or nothing up to stop: the palette leaves it out. */
  startAllCommands: (() => void) | null;
  stopAllCommands: (() => void) | null;
  openWorkspace: () => void;
  newAgent: () => void;
  newSession: () => void;
  /** A blank page, the address bar ready; `incognito` keeps it off the disk. */
  newBrowser: (incognito: boolean) => void;
  closeTab: (id: string) => void;
  inTabs: (act: () => void) => () => void;
  /** Null while a terminal or a page fills the tab: those zoom themselves. */
  zoom: ((delta: number) => void) | null;
};

/** The app-wide hotkeys: everything the shell answers no matter what has focus. */
export function useAppCommands(deps: Deps) {
  const { workspaces, tabs, pages, inTabs } = deps;
  // Going somewhere else leaves whatever page was over the workspace: settings are not where you went.
  const away = (act: () => void) => () => {
    pages.close();
    act();
  };
  useCommands({
    "open-palette": () => deps.togglePalette("all"),
    "go-to-file": () => deps.togglePalette("files"),
    "open-actions": () => deps.togglePalette("actions"),
    "open-workspace": deps.openWorkspace,
    "switch-workspace": () => deps.togglePalette("context"),
    "next-worktree": away(() => deps.worktrees.step(1)),
    "prev-worktree": away(() => deps.worktrees.step(-1)),
    "worktree-1": away(() => deps.worktrees.selectAt(0)),
    "worktree-2": away(() => deps.worktrees.selectAt(1)),
    "worktree-3": away(() => deps.worktrees.selectAt(2)),
    "worktree-4": away(() => deps.worktrees.selectAt(3)),
    "worktree-5": away(() => deps.worktrees.selectAt(4)),
    "worktree-6": away(() => deps.worktrees.selectAt(5)),
    "worktree-7": away(() => deps.worktrees.selectAt(6)),
    "worktree-8": away(() => deps.worktrees.selectAt(7)),
    "worktree-9": away(() => deps.worktrees.selectAt(8)),
    "new-worktree": deps.newWorktree,
    shortcuts: deps.toggleShortcuts,
    "next-workspace": away(() => workspaces.step(1)),
    "prev-workspace": away(() => workspaces.step(-1)),
    "workspace-1": away(() => workspaces.activateAt(0)),
    "workspace-2": away(() => workspaces.activateAt(1)),
    "workspace-3": away(() => workspaces.activateAt(2)),
    "workspace-4": away(() => workspaces.activateAt(3)),
    "workspace-5": away(() => workspaces.activateAt(4)),
    "workspace-6": away(() => workspaces.activateAt(5)),
    "workspace-7": away(() => workspaces.activateAt(6)),
    "workspace-8": away(() => workspaces.activateAt(7)),
    "workspace-9": away(() => workspaces.activateAt(8)),
    "toggle-sidebar": deps.toggleSidebar,
    "toggle-explorer": deps.toggleExplorer,
    "search-files": deps.searchFiles,
    "new-agent": deps.newAgent,
    "new-session": deps.newSession,
    "new-browser-tab": () => deps.newBrowser(false),
    "new-incognito-tab": () => deps.newBrowser(true),
    "open-history": deps.openHistory,
    "open-commands": deps.openCommands,
    "start-all-commands": deps.startAllCommands ?? undefined,
    "stop-all-commands": deps.stopAllCommands ?? undefined,
    "open-routines": () => pages.toggle({ kind: "routines", draft: null }),
    "open-settings": () => pages.toggle({ kind: "settings", section: SETTINGS_DEFAULT }),
    "open-browser-settings": () => pages.openSettings("browser"),
    "reopen-tab": inTabs(tabs.reopen),
    "next-tab": inTabs(() => tabs.step(1)),
    "prev-tab": inTabs(() => tabs.step(-1)),
    "zoom-in": deps.zoom ? () => deps.zoom?.(1) : undefined,
    "zoom-out": deps.zoom ? () => deps.zoom?.(-1) : undefined,
    "zoom-reset": deps.zoom ? () => deps.zoom?.(0) : undefined,
    close: () => {
      if (deps.palette) deps.closePalette();
      else if (deps.sheetOpen) deps.closeSheet();
      else if (!pages.isWorkspace) pages.close();
      else if (tabs.active) deps.closeTab(tabs.active.id);
    },
  });
}
