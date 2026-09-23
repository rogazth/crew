// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Icons are presentation, and the barrel costs over a second to import.
vi.mock("@phosphor-icons/react", () => new Proxy({}, { has: () => true, get: (_, key) => (key === "then" ? undefined : () => null) }));

import { IS_MAC } from "../lib/hotkey";
import type { Workspace } from "../lib/types";
import { click, dispatch, mount, only, press, type, type Mounted } from "../test/dom";
import { act } from "../test/renderHook";
import { WorkspacePicker } from "./WorkspacePicker";

const DELETE_CHORD: [string, { metaKey?: boolean }] = IS_MAC ? ["Backspace", { metaKey: true }] : ["Delete", {}];

const workspace = (id: string, name: string): Workspace => ({ id, name, path: `/Users/me/code/${name}`, createdAt: 0 });
const FEW = [workspace("w1", "crew"), workspace("w2", "storefront"), workspace("w3", "docs")];
const MANY = Array.from({ length: 10 }, (_, i) => workspace(`m${i}`, `project-${String.fromCharCode(97 + i)}`));

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

async function render(workspaces: Workspace[] = FEW, initiallyOpen = true) {
  const handlers = {
    onOpenChange: vi.fn(),
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    onReorder: vi.fn(),
  };
  function Harness() {
    const [open, setOpen] = useState(initiallyOpen);
    return (
      <WorkspacePicker
        {...handlers}
        workspaces={workspaces}
        activeId="w1"
        open={open}
        onOpenChange={(next) => {
          handlers.onOpenChange(next);
          setOpen(next);
        }}
      />
    );
  }
  view = mount(<Harness />);
  await settle();
  return handlers;
}

const settle = () => act(async () => {});
const rows = () => [...document.body.querySelectorAll<HTMLButtonElement>('[aria-label="Workspaces"] button')];
const row = (name: string) => rows().find((el) => el.textContent?.includes(name))!;
const focused = () => (document.activeElement ?? document.body) as HTMLElement;

describe("WorkspacePicker", () => {
  it("opens from its trigger", async () => {
    const { onOpenChange } = await render(FEW, false);
    click(only(view!.container, "button"));
    await settle();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("switches to a clicked workspace and closes", async () => {
    const { onSelect, onOpenChange } = await render();
    click(row("storefront"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w2");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("moves through the rows with the arrow keys and picks with Enter", async () => {
    const { onSelect } = await render();
    press(focused(), "ArrowDown");
    press(focused(), "ArrowDown");
    press(focused(), "ArrowDown");
    press(focused(), "ArrowUp");
    expect(press(focused(), "Enter")).toBe(true);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w2");
  });

  it("holds the cursor on the first row", async () => {
    const { onSelect } = await render();
    press(focused(), "ArrowUp");
    press(focused(), "Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1");
  });

  it("puts the cursor on the row under the pointer", async () => {
    const { onSelect } = await render();
    dispatch(row("docs"), new MouseEvent("mouseover", { bubbles: true }));
    press(focused(), "Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w3");
  });

  it("picks a row by its digit", async () => {
    const { onSelect } = await render();
    expect(press(focused(), "3")).toBe(true);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w3");
  });

  it("ignores a digit past the last row, and one held with Ctrl or ⌘", async () => {
    const { onSelect } = await render();
    expect(press(focused(), "4")).toBe(false);
    press(focused(), "2", { ctrlKey: true });
    press(focused(), "2", { metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens a new workspace from the footer and closes", async () => {
    const { onCreate, onOpenChange } = await render();
    click([...document.body.querySelectorAll("button")].find((el) => el.textContent?.includes("Open workspace"))!);
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("removes a row on the delete chord", async () => {
    const { onRemove, onSelect } = await render();
    press(row("docs"), ...DELETE_CHORD);
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(FEW[2]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renames a row from its context menu", async () => {
    const { onRename } = await render();
    dispatch(row("storefront"), new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    const input = only<HTMLInputElement>(document.body, 'input[aria-label="Rename"]');
    expect(input.value).toBe("storefront");
    type(input, "shop");
    press(input, "Enter");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("w2", "shop");
  });

  it("opens the rename menu on F2", async () => {
    const { onRename } = await render();
    expect(press(row("docs"), "F2")).toBe(true);
    const input = only<HTMLInputElement>(document.body, 'input[aria-label="Rename"]');
    type(input, "handbook");
    press(input, "Enter");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("w3", "handbook");
  });

  it("removes a row from its context menu", async () => {
    const { onRemove } = await render();
    dispatch(row("docs"), new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    click(only(document.body, '[role="menuitem"]'));
    await settle();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(FEW[2]);
  });

  it("closes the context menu on Escape without renaming", async () => {
    const { onRename, onRemove } = await render();
    dispatch(row("docs"), new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const input = only<HTMLInputElement>(document.body, 'input[aria-label="Rename"]');
    type(input, "handbook");
    press(input, "Escape");
    await settle();
    expect(onRename).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  describe("with many workspaces", () => {
    const search = () => only<HTMLInputElement>(document.body, 'input[aria-label="Search workspaces"]');

    it("starts in a search field", async () => {
      await render(MANY);
      expect(document.activeElement).toBe(search());
    });

    it("picks the best match for the search on Enter", async () => {
      const { onSelect } = await render(MANY);
      press(search(), "ArrowDown");
      type(search(), "project-f");
      press(search(), "Enter");
      expect(onSelect).toHaveBeenCalledExactlyOnceWith("m5");
    });

    it("types digits into the search instead of picking rows", async () => {
      const { onSelect } = await render(MANY);
      type(search(), "p");
      expect(press(search(), "2")).toBe(false);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("picks nothing when nothing matches", async () => {
      const { onSelect } = await render(MANY);
      type(search(), "zzz");
      press(search(), "ArrowDown");
      press(search(), "Enter");
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("still picks by digit before anything is typed", async () => {
      const { onSelect } = await render(MANY);
      press(search(), "9");
      expect(onSelect).toHaveBeenCalledExactlyOnceWith("m8");
    });
  });
});
