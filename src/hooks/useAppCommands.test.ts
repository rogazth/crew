// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { PaletteMode } from "../chrome/CommandPalette";
import { runCommand, type CommandId } from "../lib/commands";
import type { Tab } from "../lib/types";
import { renderHook } from "../test/renderHook";
import { useAppCommands } from "./useAppCommands";
import type { usePages } from "./usePages";
import type { useTabs } from "./useTabs";
import type { useWorkspaces } from "./useWorkspaces";

type State = { palette: PaletteMode | null; sheetOpen: boolean; isWorkspace: boolean; active: Tab | null };

type Pages = Pick<ReturnType<typeof usePages>, "isWorkspace" | "close" | "toggle">;

const tab: Tab = { id: "session:a", kind: "session", sessionId: "a" };

function setup(initial: Partial<State> = {}) {
  const calls: string[] = [];
  /** A stand-in that records its name and arguments, e.g. `activateAt 0`. */
  const log = (name: string) =>
    vi.fn((...args: unknown[]) => void calls.push([name, ...args.map((a) => JSON.stringify(a))].join(" ")));
  const workspaces = {
    workspaces: [],
    active: null,
    loading: false,
    error: null,
    activate: log("activate"),
    activateAt: log("activateAt"),
    step: log("workspaces.step"),
    create: log("workspaces.create"),
    rename: log("rename"),
    remove: log("remove"),
    reorder: log("reorder"),
  } as unknown as ReturnType<typeof useWorkspaces>;
  const tabFns = {
    tabs: [],
    panes: [],
    open: log("open"),
    close: log("tabs.close"),
    closeForSession: log("closeForSession"),
    reopen: log("tabs.reopen"),
    step: log("tabs.step"),
    activate: log("tabs.activate"),
    select: log("select"),
    dropWorkspace: log("dropWorkspace"),
  };
  const pageFns = { toggle: log("pages.toggle"), close: log("pages.close") };
  const fns = {
    togglePalette: log("togglePalette"),
    closePalette: log("closePalette"),
    closeSheet: log("closeSheet"),
    toggleSidebar: log("toggleSidebar"),
    togglePicker: log("togglePicker"),
    newAgent: log("newAgent"),
    newSession: log("newSession"),
    closeTab: log("closeTab"),
    inTabs: (act: () => void) => () => {
      calls.push("inTabs");
      act();
    },
  };
  const deps = (state: State) => ({
    ...fns,
    workspaces,
    tabs: { ...tabFns, active: state.active } as ReturnType<typeof useTabs>,
    pages: { ...pageFns, isWorkspace: state.isWorkspace } as Pages,
    palette: state.palette,
    sheetOpen: state.sheetOpen,
  });
  const start: State = { palette: null, sheetOpen: false, isWorkspace: true, active: tab, ...initial };
  const hook = renderHook((state: State) => useAppCommands(deps(state)), start);
  /** Runs a command and returns what it called. */
  const run = (id: CommandId) => {
    calls.length = 0;
    expect(runCommand(id)).toBe(true);
    return [...calls];
  };
  return { hook, run };
}

describe("useAppCommands", () => {
  it.each<[CommandId, string[]]>([
    ["open-palette", ['togglePalette "all"']],
    ["go-to-file", ['togglePalette "files"']],
    ["open-actions", ['togglePalette "actions"']],
    ["open-workspace", ["workspaces.create"]],
    ["switch-workspace", ["togglePicker"]],
    ["next-workspace", ["workspaces.step 1"]],
    ["prev-workspace", ["workspaces.step -1"]],
    ["workspace-1", ["activateAt 0"]],
    ["workspace-2", ["activateAt 1"]],
    ["workspace-3", ["activateAt 2"]],
    ["workspace-4", ["activateAt 3"]],
    ["workspace-5", ["activateAt 4"]],
    ["workspace-6", ["activateAt 5"]],
    ["workspace-7", ["activateAt 6"]],
    ["workspace-8", ["activateAt 7"]],
    ["workspace-9", ["activateAt 8"]],
    ["toggle-sidebar", ["toggleSidebar"]],
    ["new-agent", ["newAgent"]],
    ["new-session", ["newSession"]],
    ["search-messages", ['pages.toggle {"kind":"search"}']],
    ["open-routines", ['pages.toggle {"kind":"routines","draft":null}']],
    ["open-settings", ['pages.toggle {"kind":"settings","section":"general"}']],
    ["reopen-tab", ["inTabs", "tabs.reopen"]],
    ["next-tab", ["inTabs", "tabs.step 1"]],
    ["prev-tab", ["inTabs", "tabs.step -1"]],
  ])("%s does its job", (id, expected) => {
    const { hook, run } = setup();
    expect(run(id)).toEqual(expected);
    hook.unmount();
  });

  it("closes the palette first, then the sheet, then the page, then the tab", () => {
    const { hook, run } = setup({ palette: "all", sheetOpen: true, isWorkspace: false });
    expect(run("close")).toEqual(["closePalette"]);

    hook.rerender({ palette: null, sheetOpen: true, isWorkspace: false, active: tab });
    expect(run("close")).toEqual(["closeSheet"]);

    hook.rerender({ palette: null, sheetOpen: false, isWorkspace: false, active: tab });
    expect(run("close")).toEqual(["pages.close"]);

    hook.rerender({ palette: null, sheetOpen: false, isWorkspace: true, active: tab });
    expect(run("close")).toEqual(['closeTab "session:a"']);

    hook.rerender({ palette: null, sheetOpen: false, isWorkspace: true, active: null });
    expect(run("close")).toEqual([]);
    hook.unmount();
  });

  it("leaves no command behind on unmount", () => {
    const { hook } = setup();
    hook.unmount();
    expect(runCommand("open-palette")).toBe(false);
    expect(runCommand("close")).toBe(false);
  });
});
