// @vitest-environment happy-dom
import { Sidebar } from "@cloudflare/kumo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

import { IS_MAC } from "../lib/hotkey";
import { DEFAULT_PREFS, type SidebarPrefs } from "../lib/sidebarPrefs";
import type { Session, Workspace } from "../lib/types";
import { click, dispatch, mount, only, press, type, type Mounted } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { SessionSidebar, type SessionSidebarProps } from "./SessionSidebar";

const TOGGLE = IS_MAC ? { metaKey: true } : { ctrlKey: true };
const DELETE_CHORD: [string, { metaKey?: boolean }] = IS_MAC ? ["Backspace", { metaKey: true }] : ["Delete", {}];

function session(id: string, kind: Session["kind"], updatedAt: number): Session {
  return {
    id,
    workspaceId: "w1",
    kind,
    name: id,
    provider: "claude",
    model: "",
    providerSessionId: null,
    description: "",
    notifications: true,
    autonomy: "ask",
    status: "idle",
    createdAt: 0,
    updatedAt,
  };
}

// Default prefs group by kind and order by last update, newest first.
const SESSIONS = [
  session("research", "agent", 40),
  session("reviewer", "agent", 30),
  session("writer", "agent", 20),
  session("zsh", "terminal", 10),
  session("server", "terminal", 5),
];
const [research, reviewer, writer, zsh, server] = SESSIONS as [Session, Session, Session, Session, Session];
const WORKSPACES: Workspace[] = [
  { id: "w1", name: "crew", path: "/code/crew", createdAt: 0 },
  { id: "w2", name: "storefront", path: "/code/storefront", createdAt: 0 },
];

let view: Mounted | null = null;
let stored: SidebarPrefs | null = null;

beforeEach(() => {
  fake.reset();
  stored = null;
  fake.respond("state_get", ({ key }) => (key === "sidebar:prefs" && stored ? JSON.stringify(stored) : null));
  fake.respond("state_set", () => undefined);
});

afterEach(() => {
  view?.unmount();
  view = null;
});

const settle = () => act(async () => {});

function handlers() {
  return {
    onPickerOpenChange: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onCreateWorkspace: vi.fn(),
    onRenameWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
    onReorderWorkspaces: vi.fn(),
    onSelect: vi.fn(),
    onNewAgent: vi.fn(),
    onNewSession: vi.fn(),
    onOpenRoutines: vi.fn(),
    onOpenSettings: vi.fn(),
    onEdit: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    onRemoveMany: vi.fn(),
    onReorder: vi.fn(),
  };
}

async function render(patch: Partial<SessionSidebarProps> = {}) {
  const on = handlers();
  const props: SessionSidebarProps = {
    ...on,
    workspace: WORKSPACES[0]!,
    workspaces: WORKSPACES,
    pickerOpen: false,
    sessions: SESSIONS,
    activeSessionId: null,
    settingsOpen: false,
    routinesOpen: false,
    ...patch,
  };
  const node = (next: SessionSidebarProps) => (
    <Sidebar.Provider>
      <SessionSidebar {...next} />
    </Sidebar.Provider>
  );
  view = mount(node(props));
  await settle();
  return { ...on, rerender: (next: Partial<SessionSidebarProps>) => view!.rerender(node({ ...props, ...next })) };
}

const row = (name: string) => document.body.querySelector<HTMLButtonElement>(`button[title="${name}"]`)!;
/** The sessions the list offers, top to bottom. */
const offered = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")]
    .map((el) => el.title)
    .filter((title) => SESSIONS.some((s) => s.name === title));
const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim().startsWith(text))!;
const menuItem = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent?.startsWith(text))!;

async function openMenu(name: string) {
  dispatch(row(name), new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }));
  await settle();
}

describe("SessionSidebar", () => {
  describe("selection", () => {
    it("opens a session on a plain click", async () => {
      const { onSelect } = await render();
      click(row("reviewer"));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(reviewer);
    });

    it("builds a selection with the toggle modifier and deletes it together", async () => {
      const { onSelect, onRemoveMany, onRemove } = await render({ activeSessionId: "research" });
      click(row("writer"), TOGGLE);
      click(row("zsh"), TOGGLE);
      press(row("zsh"), ...DELETE_CHORD);
      expect(onRemoveMany).toHaveBeenCalledExactlyOnceWith([research, writer, zsh]);
      expect(onRemove).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("toggles a row back out of the selection", async () => {
      const { onRemoveMany } = await render({ activeSessionId: "research" });
      click(row("writer"), TOGGLE);
      click(row("zsh"), TOGGLE);
      click(row("writer"), TOGGLE);
      press(row("zsh"), ...DELETE_CHORD);
      expect(onRemoveMany).toHaveBeenCalledExactlyOnceWith([research, zsh]);
    });

    it("extends from the open session to a Shift-clicked row, in list order", async () => {
      const { onRemoveMany } = await render({ activeSessionId: "reviewer" });
      click(row("zsh"), { shiftKey: true });
      press(row("reviewer"), ...DELETE_CHORD);
      expect(onRemoveMany).toHaveBeenCalledExactlyOnceWith([reviewer, writer, zsh]);
    });

    it("deletes a row outside the selection on its own", async () => {
      const { onRemove, onRemoveMany } = await render({ activeSessionId: "research" });
      click(row("reviewer"), TOGGLE);
      press(row("server"), ...DELETE_CHORD);
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(server);
      expect(onRemoveMany).not.toHaveBeenCalled();
    });

    it("deletes the open session on its own", async () => {
      const { onRemove } = await render({ activeSessionId: "research" });
      expect(press(row("research"), ...DELETE_CHORD)).toBe(true);
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(research);
    });

    it("drops the selection on Escape", async () => {
      const { onRemove, onRemoveMany } = await render({ activeSessionId: "research" });
      click(row("reviewer"), TOGGLE);
      press(row("reviewer"), "Escape");
      press(row("reviewer"), ...DELETE_CHORD);
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(reviewer);
      expect(onRemoveMany).not.toHaveBeenCalled();
    });

    it("drops the selection when the open session changes", async () => {
      const { onRemove, onRemoveMany, rerender } = await render({ activeSessionId: "research" });
      click(row("reviewer"), TOGGLE);
      rerender({ activeSessionId: "writer" });
      press(row("reviewer"), ...DELETE_CHORD);
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(reviewer);
      expect(onRemoveMany).not.toHaveBeenCalled();
    });

    it("forgets selected rows the search hides", async () => {
      const { onRemoveMany } = await render({ activeSessionId: "research" });
      click(row("reviewer"), TOGGLE);
      click(row("zsh"), TOGGLE);
      type(only<HTMLInputElement>(document.body, 'input[aria-label="Find agents and sessions"]'), "r");
      press(row("reviewer"), ...DELETE_CHORD);
      expect(onRemoveMany).toHaveBeenCalledExactlyOnceWith([research, reviewer]);
    });

    it("clears a held selection on a plain click", async () => {
      const { onRemove, onSelect } = await render({ activeSessionId: "research" });
      click(row("reviewer"), TOGGLE);
      click(row("writer"));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(writer);
      press(row("reviewer"), ...DELETE_CHORD);
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(reviewer);
    });
  });

  describe("row menu", () => {
    it("edits or deletes an agent", async () => {
      const { onEdit, onRemove } = await render();
      await openMenu("writer");
      click(menuItem("Edit"));
      expect(onEdit).toHaveBeenCalledExactlyOnceWith(writer);

      await openMenu("writer");
      click(menuItem("Delete"));
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(writer);
    });

    it("renames a terminal in place", async () => {
      const { onRename } = await render();
      await openMenu("zsh");
      click(menuItem("Rename"));
      await settle();
      const input = only<HTMLInputElement>(document.body, 'input[aria-label="Rename"]');
      type(input, "build");
      press(input, "Enter");
      expect(onRename).toHaveBeenCalledExactlyOnceWith(zsh, "build");
    });

    it("deletes the whole selection from a selected row", async () => {
      const { onRemoveMany } = await render({ activeSessionId: "research" });
      click(row("zsh"), TOGGLE);
      await openMenu("zsh");
      const item = menuItem("Delete");
      expect(item.textContent).toContain("Delete 2 items");
      click(item);
      expect(onRemoveMany).toHaveBeenCalledExactlyOnceWith([research, zsh]);
    });

    it("selects only an unselected row it opens on", async () => {
      const { onRemove, onRemoveMany } = await render({ activeSessionId: "research" });
      click(row("zsh"), TOGGLE);
      await openMenu("server");
      click(menuItem("Delete"));
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(server);
      press(row("zsh"), ...DELETE_CHORD);
      expect(onRemove).toHaveBeenLastCalledWith(zsh);
      expect(onRemoveMany).not.toHaveBeenCalled();
    });

    it("closes on Escape without acting", async () => {
      const { onEdit, onRemove } = await render();
      await openMenu("writer");
      const menu = only(document.body, '[role="menu"]');
      press(window, "Escape");
      await settle();
      press(menu, "e");
      expect(onEdit).not.toHaveBeenCalled();
      expect(onRemove).not.toHaveBeenCalled();
    });
  });

  describe("rename", () => {
    it("renames a terminal on F2, committing the trimmed name", async () => {
      const { onRename } = await render();
      expect(press(row("server"), "F2")).toBe(true);
      const input = only<HTMLInputElement>(document.body, 'input[aria-label="Rename"]');
      type(input, "  api  ");
      press(input, "Enter");
      expect(onRename).toHaveBeenCalledExactlyOnceWith(server, "api");
    });

    it("cancels a rename on Escape and gives the row back", async () => {
      const { onRename, onSelect } = await render();
      press(row("server"), "F2");
      const input = only<HTMLInputElement>(document.body, 'input[aria-label="Rename"]');
      type(input, "api");
      press(input, "Escape");
      expect(onRename).not.toHaveBeenCalled();
      click(row("server"));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(server);
    });

    it("has no F2 rename for an agent, whose name lives in its sheet", async () => {
      const { onSelect } = await render();
      expect(press(row("writer"), "F2")).toBe(false);
      click(row("writer"));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(writer);
    });
  });

  describe("search", () => {
    const search = () => only<HTMLInputElement>(document.body, 'input[aria-label="Find agents and sessions"]');

    it("narrows the list as you type", async () => {
      await render();
      expect(offered()).toEqual(["research", "reviewer", "writer", "zsh", "server"]);
      type(search(), "zsh");
      expect(offered()).toEqual(["zsh"]);
    });

    it("clears on Escape", async () => {
      const { onSelect } = await render();
      type(search(), "zsh");
      press(search(), "Escape");
      expect(search().value).toBe("");
      click(row("research"));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(research);
    });
  });

  describe("actions", () => {
    it.each([
      ["New agent", "onNewAgent"],
      ["New session", "onNewSession"],
      ["Routines", "onOpenRoutines"],
      ["Settings", "onOpenSettings"],
    ] as const)("%s runs its action", async (label, handler) => {
      const on = await render();
      click(button(label));
      expect(on[handler]).toHaveBeenCalledOnce();
    });

    it("adds to a group from its plus", async () => {
      const { onNewAgent, onNewSession } = await render();
      click(only(document.body, 'button[aria-label="Add Agents"]'));
      expect(onNewAgent).toHaveBeenCalledOnce();
      click(only(document.body, 'button[aria-label="Add Sessions"]'));
      expect(onNewSession).toHaveBeenCalledOnce();
    });

    it("hands workspace picks to its owner", async () => {
      const { onSelectWorkspace, onPickerOpenChange } = await render({ pickerOpen: true });
      click([...document.body.querySelectorAll<HTMLButtonElement>('[aria-label="Workspaces"] button')].find((el) => el.textContent?.includes("storefront"))!);
      await settle();
      expect(onSelectWorkspace).toHaveBeenCalledExactlyOnceWith("w2");
      expect(onPickerOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe("preferences", () => {
    it("orders the list, and so a Shift range, by the stored preferences", async () => {
      stored = { ...DEFAULT_PREFS, ordering: "name" };
      const { onRemoveMany } = await render({ activeSessionId: "reviewer" });
      expect(offered()).toEqual(["research", "reviewer", "writer", "server", "zsh"]);
      click(row("server"), { shiftKey: true });
      press(row("server"), ...DELETE_CHORD);
      expect(onRemoveMany).toHaveBeenCalledExactlyOnceWith([reviewer, writer, server]);
    });

    it("hides what the stored filters hide", async () => {
      stored = { ...DEFAULT_PREFS, hiddenKinds: ["terminal"] };
      await render();
      expect(offered()).toEqual(["research", "reviewer", "writer"]);
    });

    it("stores a changed preference", async () => {
      await render();
      click(only(document.body, 'button[aria-label="Customize sidebar"]'));
      await settle();
      click(menuItem("Grouping"));
      await settle();
      click([...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.startsWith("Status"))!);
      await settle();
      expect(fake.sent("state_set")).toEqual([
        { key: "sidebar:prefs", value: JSON.stringify({ ...DEFAULT_PREFS, grouping: "status" }) },
      ]);
    });
  });
});
