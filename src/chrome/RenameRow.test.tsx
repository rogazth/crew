// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch, mount, only, press, type, type Mounted } from "../test/dom";
import { RenameRow } from "./RenameRow";

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

function render(initial = "zsh") {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  view = mount(<RenameRow initial={initial} onCommit={onCommit} onCancel={onCancel} />);
  const input = only<HTMLInputElement>(view.container, 'input[aria-label="Rename"]');
  return { input, onCommit, onCancel };
}

const blur = (input: HTMLInputElement) => dispatch(input, new FocusEvent("focusout", { bubbles: true }));

describe("RenameRow", () => {
  it("focuses the field with the current name selected", () => {
    const { input } = render("zsh");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("zsh");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
  });

  it("commits the trimmed name on Enter", () => {
    const { input, onCommit, onCancel } = render();
    type(input, "  build  ");
    expect(press(input, "Enter")).toBe(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("build");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels on Escape, whatever was typed", () => {
    const { input, onCommit, onCancel } = render();
    type(input, "build");
    expect(press(input, "Escape")).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits on blur", () => {
    const { input, onCommit } = render();
    type(input, "build");
    blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("build");
  });

  it("refuses an empty name and cancels instead", () => {
    const { input, onCommit, onCancel } = render();
    type(input, "   ");
    press(input, "Enter");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels when the name did not change", () => {
    const { input, onCommit, onCancel } = render("zsh");
    press(input, "Enter");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("finishes once: the blur that follows Enter or Escape does nothing", () => {
    const first = render();
    type(first.input, "build");
    press(first.input, "Enter");
    blur(first.input);
    expect(first.onCommit).toHaveBeenCalledOnce();
    expect(first.onCancel).not.toHaveBeenCalled();
    view?.unmount();

    const second = render();
    type(second.input, "build");
    press(second.input, "Escape");
    blur(second.input);
    expect(second.onCancel).toHaveBeenCalledOnce();
    expect(second.onCommit).not.toHaveBeenCalled();
  });

  it("leaves other keys to the field", () => {
    const { input, onCommit, onCancel } = render();
    expect(press(input, "a")).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
