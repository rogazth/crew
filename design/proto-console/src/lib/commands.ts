import { COMMANDS, STUB_LABELS, matchesChord, type CommandId } from "@crew/fixtures";
import { store } from "./store";

/** Every command the shell binds, as a function. The chord table lives in fixtures. */
export const ACTIONS: Record<CommandId, () => void> = {
  "open-launcher": () => store.openOverlay({ kind: "launcher" }),
  close: () => store.closeActiveTab(),
  "reopen-tab": () => store.reopenTab(),
  "next-tab": () => store.stepTab(1),
  "prev-tab": () => store.stepTab(-1),
  "tab-1": () => store.tabAt(0),
  "tab-2": () => store.tabAt(1),
  "tab-3": () => store.tabAt(2),
  "tab-4": () => store.tabAt(3),
  "tab-5": () => store.tabAt(4),
  "tab-6": () => store.tabAt(5),
  "tab-7": () => store.tabAt(6),
  "tab-8": () => store.tabAt(7),
  "last-tab": () => store.lastTab(),

  "open-palette": () => store.openPalette("all"),
  "go-to-file": () => store.openPalette("files"),
  "open-actions": () => store.openPalette("actions", ">"),
  "open-workspace": () => store.openOverlay({ kind: "workspaces" }),
  "switch-workspace": () => store.openOverlay({ kind: "workspaces" }),
  "next-workspace": () => store.stepWorkspace(1),
  "prev-workspace": () => store.stepWorkspace(-1),
  "workspace-1": () => store.workspaceAt(0),
  "workspace-2": () => store.workspaceAt(1),
  "workspace-3": () => store.workspaceAt(2),

  "new-agent": () => store.openOverlay({ kind: "sheet", sessionId: null }),
  "new-session": () => {
    const session = store.createSession({ kind: "terminal", name: `shell ${store.state.sessions.length}` });
    store.openSession(session.id);
  },

  "find-in-terminal": () => emit("terminal:find"),
  "zoom-in": () => emit("terminal:zoom", 1),
  "zoom-out": () => emit("terminal:zoom", -1),
  "zoom-reset": () => emit("terminal:zoom", 0),

  "toggle-sidebar": () => store.toggleSidebar(),
  "toggle-theme": () => store.toggleTheme(),
  "open-routines": () => store.openRoutines(null),
  "search-messages": () => store.openSearch(store.state.page.kind === "search" ? store.state.page.query : ""),
  "open-settings": () => store.openSettings("general"),

  "save-file": () => {
    const tab = store.activeTab;
    if (tab?.kind === "file") store.saveFile(tab.relative);
  },
};

/** Surfaces own their own chrome; the shell reaches them through one event bus. */
const bus = new EventTarget();

export function emit(type: string, detail?: unknown): void {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function on(type: string, listener: (detail: unknown) => void): () => void {
  const wrapped = (event: Event) => listener((event as CustomEvent).detail);
  bus.addEventListener(type, wrapped);
  return () => bus.removeEventListener(type, wrapped);
}

const TYPING = /^(input|textarea|select)$/i;

function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return TYPING.test(node.tagName) || node.isContentEditable;
}

/**
 * One listener for the whole window. Chords come from the store so a rebinding
 * in settings takes effect without a reload.
 */
export function installHotkeys(): () => void {
  const onKey = (event: KeyboardEvent) => {
    const typing = isTyping(event.target);

    // A page covers the tabs; Escape is how you get back to them.
    if (
      event.key === "Escape" &&
      store.state.overlay === null &&
      store.state.page.kind !== "none" &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      store.closePage();
      return;
    }

    if (event.key === "?" && !typing) {
      event.preventDefault();
      store.openOverlay({ kind: "shortcuts" });
      return;
    }

    for (const id of Object.keys(ACTIONS) as CommandId[]) {
      const chord = store.state.keys[id] ?? COMMANDS[id].keys;
      if (!matchesChord(event, chord)) continue;
      // A terminal owns Mod+F only while a terminal is on screen.
      if (id === "find-in-terminal" && !terminalOnScreen()) continue;
      if (id === "save-file" && store.activeTab?.kind !== "file") continue;
      if ((id === "zoom-in" || id === "zoom-out" || id === "zoom-reset") && !terminalOnScreen()) continue;
      event.preventDefault();
      event.stopPropagation();
      ACTIONS[id]();
      return;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

function terminalOnScreen(): boolean {
  const tab = store.activeTab;
  if (store.state.page.kind !== "none") return false;
  if (tab?.kind === "stub" && tab.stub === "terminal") return true;
  if (tab?.kind !== "session") return false;
  return store.session(tab.sessionId)?.kind === "terminal";
}

export const stubTitle = (stub: string) => STUB_LABELS[stub] ?? stub;

