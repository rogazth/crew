// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Icons are presentation, and the barrel costs over a second to import.
vi.mock("@phosphor-icons/react", () => new Proxy({}, { has: () => true, get: (_, key) => (key === "then" ? undefined : () => null) }));

import { registerCommand } from "../lib/commands";
import type { ProjectFile, Session, Workspace } from "../lib/types";
import { click, dispatch, mount, only, press, type, type Mounted } from "../test/dom";
import { CommandPalette, type PaletteMode } from "./CommandPalette";

function session(id: string, kind: Session["kind"], updatedAt = 0): Session {
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

const file = (relative: string): ProjectFile => ({ name: relative.split("/").pop()!, path: `/repo/${relative}`, relative });
const workspace = (id: string, name: string): Workspace => ({ id, name, path: `/code/${name}`, createdAt: 0 });

const SESSIONS = [
  session("research", "agent", 3),
  session("reviewer", "agent", 1),
  session("zsh", "terminal", 2),
  session("server", "terminal", 4),
];
const FILES = [file("src/main.ts"), file("src/lib/menu.ts"), file("README.md")];
const WORKSPACES = [workspace("w1", "crew"), workspace("w2", "storefront")];

let view: Mounted | null = null;
let unregister: (() => void)[] = [];
const ran: string[] = [];

beforeEach(() => {
  ran.length = 0;
  unregister = [
    registerCommand("new-agent", () => ran.push("new-agent")),
    registerCommand("open-settings", () => ran.push("open-settings")),
  ];
});

afterEach(() => {
  view?.unmount();
  view = null;
  for (const off of unregister) off();
});

function render(mode: PaletteMode, props: { files?: ProjectFile[]; sessions?: Session[] } = {}) {
  const handlers = {
    onOpenFile: vi.fn(),
    onOpenSession: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onClose: vi.fn(() => ran.push("close")),
  };
  const node = (files: ProjectFile[]) => (
    <CommandPalette
      mode={mode}
      files={files}
      sessions={props.sessions ?? SESSIONS}
      workspaces={WORKSPACES}
      activeWorkspaceId="w1"
      {...handlers}
    />
  );
  view = mount(node(props.files ?? FILES));
  const search = only<HTMLInputElement>(view.container, 'input[aria-label="Search"]');
  return { ...handlers, search, setFiles: (files: ProjectFile[]) => view!.rerender(node(files)) };
}

const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.includes(text))!;

describe("CommandPalette", () => {
  it("focuses the search field on open", () => {
    const { search } = render("all");
    expect(document.activeElement).toBe(search);
  });

  it("opens the first row on Enter, then closes", () => {
    const { search, onOpenSession, onClose } = render("sessions");
    expect(press(search, "Enter")).toBe(true);
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(SESSIONS[2]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves the selection with the arrow keys", () => {
    const { search, onOpenSession } = render("agents");
    expect(press(search, "ArrowDown")).toBe(true);
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenLastCalledWith(SESSIONS[1]);
    expect(press(search, "ArrowUp")).toBe(true);
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenLastCalledWith(SESSIONS[0]);
  });

  it("holds the selection at both ends of the list", () => {
    const { search, onOpenSession } = render("agents");
    press(search, "ArrowUp");
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenLastCalledWith(SESSIONS[0]);
    press(search, "ArrowDown");
    press(search, "ArrowDown");
    press(search, "ArrowDown");
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenLastCalledWith(SESSIONS[1]);
  });

  it("selects the row under the pointer", () => {
    const { search, onOpenSession } = render("agents");
    dispatch(button("reviewer"), new MouseEvent("mouseover", { bubbles: true }));
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(SESSIONS[1]);
  });

  it("selects a row in a later group under the pointer", () => {
    const { search, onOpenSession } = render("all");
    dispatch(button("Settings"), new MouseEvent("mouseover", { bubbles: true }));
    press(search, "Enter");
    expect(ran).toEqual(["close", "open-settings"]);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("walks from the last recent session into the actions", () => {
    const { search } = render("all");
    for (let i = 0; i < SESSIONS.length; i += 1) press(search, "ArrowDown");
    press(search, "Enter");
    expect(ran).toEqual(["close", "new-agent"]);
  });

  it("opens a row on click", () => {
    const { onOpenFile, onClose } = render("files");
    click(button("menu.ts"));
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(FILES[1]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape without opening anything", () => {
    const { search, onClose, onOpenSession } = render("all");
    press(search, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("closes on a click outside, not inside", () => {
    const { onClose } = render("all");
    click(only(document.body, '[role="dialog"]'));
    expect(onClose).not.toHaveBeenCalled();
    click(only(document.body, '[role="presentation"]'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("filters as you type and puts the selection back on the first match", () => {
    const { search, onOpenFile } = render("files");
    press(search, "ArrowDown");
    type(search, "readme");
    press(search, "Enter");
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(FILES[2]);
  });

  it("opens nothing when nothing matches", () => {
    const { search, onOpenFile, onClose } = render("files");
    type(search, "zzzz");
    press(search, "Enter");
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens the most recent session first on a cold All", () => {
    const { search, onOpenSession } = render("all");
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(SESSIONS[3]);
  });

  it("moves to the next filter on Tab and back on Shift+Tab", () => {
    const { search, onOpenSession } = render("all");
    expect(press(search, "Tab")).toBe(true);
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenLastCalledWith(SESSIONS[0]);

    press(search, "Tab", { shiftKey: true });
    press(search, "Tab", { shiftKey: true });
    type(search, "settings");
    press(search, "Enter");
    expect(ran).toContain("open-settings");
  });

  it("switches filter from the filter row", () => {
    const { search, onOpenFile } = render("all");
    click(button("Files"));
    press(search, "Enter");
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(FILES[0]);
  });

  it("runs an action after closing, so the action owns what it opens", () => {
    const { search } = render("actions");
    type(search, "settings");
    press(search, "Enter");
    expect(ran).toEqual(["close", "open-settings"]);
  });

  it("jumps to actions on a leading >", () => {
    const { search } = render("files");
    type(search, ">new agent");
    press(search, "Enter");
    expect(ran).toEqual(["close", "new-agent"]);
  });

  it("drops the > when Tab moves on to another filter", () => {
    const { search, onOpenSession } = render("all");
    type(search, ">rev");
    press(search, "Tab");
    expect(search.value).toBe("rev");
    press(search, "Enter");
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(SESSIONS[1]);
  });

  it("offers a switch to every other workspace", () => {
    const { search, onSelectWorkspace, onClose } = render("actions");
    type(search, "storefront");
    press(search, "Enter");
    expect(onSelectWorkspace).toHaveBeenCalledExactlyOnceWith("w2");
    expect(onClose).toHaveBeenCalledOnce();
    type(search, "crew");
    press(search, "Enter");
    expect(onSelectWorkspace).toHaveBeenCalledOnce();
  });

  it("selects the first file once files arrive after an arrow key on an empty list", () => {
    const { search, setFiles, onOpenFile } = render("files", { files: [] });
    press(search, "ArrowDown");
    setFiles(FILES);
    press(search, "Enter");
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(FILES[0]);
  });
});
