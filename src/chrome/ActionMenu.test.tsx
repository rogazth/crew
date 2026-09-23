// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

// Icons are presentation, and the barrel costs over a second to import.
vi.mock("@phosphor-icons/react", () => new Proxy({}, { has: () => true, get: (_, key) => (key === "then" ? undefined : () => null) }));

import { IS_MAC } from "../lib/hotkey";
import { DELETE, EDIT, RENAME, type MenuAction } from "../lib/menu";
import { click, dispatch, mount, only, press, type, type Mounted } from "../test/dom";
import { ActionMenu } from "./ActionMenu";

const DELETE_CHORD: [string, { metaKey?: boolean }] = IS_MAC ? ["Backspace", { metaKey: true }] : ["Delete", {}];

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

function render(actions: MenuAction[], rename?: { initial: string; onCommit: (name: string) => void }) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  view = mount(
    <ActionMenu point={{ x: 10, y: 20 }} actions={actions} onPick={onPick} onClose={onClose} {...(rename ? { rename } : {})} />,
  );
  const menu = only(document.body, '[role="menu"]');
  return { menu, onPick, onClose };
}

const item = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.includes(label))!;

describe("ActionMenu", () => {
  it("takes focus so its hotkeys work at once", () => {
    const { menu } = render([EDIT, DELETE]);
    expect(document.activeElement).toBe(menu);
  });

  it("picks a row on click", () => {
    const { onPick } = render([EDIT, DELETE]);
    click(item("Edit"));
    expect(onPick).toHaveBeenCalledExactlyOnceWith("edit");
  });

  it("picks a row by its hotkey", () => {
    const { menu, onPick } = render([RENAME, DELETE]);
    expect(press(menu, "r")).toBe(true);
    expect(onPick).toHaveBeenCalledExactlyOnceWith("rename");
  });

  it("picks delete on the delete chord", () => {
    const { menu, onPick } = render([EDIT, DELETE]);
    press(menu, ...DELETE_CHORD);
    expect(onPick).toHaveBeenCalledExactlyOnceWith("delete");
  });

  it("ignores keys that fire nothing, and a disabled row's hotkey", () => {
    const { menu, onPick } = render([{ ...EDIT, disabled: true }, DELETE]);
    expect(press(menu, "x")).toBe(false);
    expect(press(menu, "e")).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { onClose } = render([EDIT]);
    expect(press(window, "Escape")).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a pointer down outside, not inside", () => {
    const { menu, onClose } = render([EDIT]);
    dispatch(menu, new PointerEvent("pointerdown", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    dispatch(document.body, new PointerEvent("pointerdown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stops listening once it is gone", () => {
    const { onClose } = render([EDIT]);
    view?.unmount();
    view = null;
    press(window, "Escape");
    dispatch(document.body, new PointerEvent("pointerdown", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the context menu of its own", () => {
    const { menu } = render([EDIT]);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    dispatch(menu, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps focus where it is when a row is pressed", () => {
    render([EDIT]);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    dispatch(item("Edit"), event);
    expect(event.defaultPrevented).toBe(true);
  });

  describe("with a rename field", () => {
    function renderRename(initial = "crew") {
      const onCommit = vi.fn();
      const handles = render([DELETE], { initial, onCommit });
      const input = only<HTMLInputElement>(document.body, 'input[aria-label="Rename"]');
      return { ...handles, input, onCommit };
    }

    it("focuses the field with the name selected", () => {
      const { input } = renderRename("crew");
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
    });

    it("commits the trimmed name on Enter and closes", () => {
      const { input, onCommit, onClose, onPick } = renderRename();
      type(input, "  api  ");
      expect(press(input, "Enter")).toBe(true);
      expect(onCommit).toHaveBeenCalledExactlyOnceWith("api");
      expect(onClose).toHaveBeenCalledOnce();
      expect(onPick).not.toHaveBeenCalled();
    });

    it("commits on blur", () => {
      const { input, onCommit } = renderRename();
      type(input, "api");
      dispatch(input, new FocusEvent("focusout", { bubbles: true }));
      expect(onCommit).toHaveBeenCalledExactlyOnceWith("api");
    });

    it("does not commit an unchanged or empty name", () => {
      const { input, onCommit, onClose } = renderRename("crew");
      press(input, "Enter");
      type(input, "  ");
      press(input, "Enter");
      expect(onCommit).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("types letters into the field instead of firing hotkeys", () => {
      const { input, onPick } = renderRename();
      press(input, "d");
      press(input, ...DELETE_CHORD);
      expect(onPick).not.toHaveBeenCalled();
    });

    it("drops the edit on Escape, even when the field then loses focus", () => {
      const { input, onCommit, onClose } = renderRename();
      type(input, "api");
      press(input, "Escape");
      dispatch(input, new FocusEvent("focusout", { bubbles: true }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(onCommit).not.toHaveBeenCalled();
    });
  });
});
