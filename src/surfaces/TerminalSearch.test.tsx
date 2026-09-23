// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, dispatch, mount, only, press, type, type Mounted } from "../test/dom";
import { TerminalSearch } from "./TerminalSearch";

// The icon barrel takes seconds to load and draws nothing these tests read.
vi.mock("@phosphor-icons/react", () => ({ CaretDownIcon: () => null, CaretUpIcon: () => null, XIcon: () => null }));

let view: Mounted | null = null;

afterEach(() => {
  view?.unmount();
  view = null;
});

function render(focusToken = 1, query = "") {
  const props = {
    query,
    results: { index: 0, count: 0 },
    focusToken,
    onQuery: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
  };
  view = mount(<TerminalSearch {...props} />);
  const field = only<HTMLInputElement>(view.container, 'input[aria-label="Find in terminal"]');
  const button = (label: string) => only<HTMLButtonElement>(view!.container, `button[aria-label="${label}"]`);
  return { props, field, button };
}

describe("TerminalSearch", () => {
  it("closes on Escape", () => {
    const { props, field } = render();
    expect(press(field, "Escape")).toBe(true);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onStep).not.toHaveBeenCalled();
  });

  it("steps forward on Enter and back on Shift+Enter", () => {
    const { props, field } = render();
    expect(press(field, "Enter")).toBe(true);
    expect(press(field, "Enter", { shiftKey: true })).toBe(true);
    expect(props.onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it("leaves other keys to the field", () => {
    const { props, field } = render();
    expect(press(field, "a")).toBe(false);
    expect(props.onStep).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("steps and closes from its buttons", () => {
    const { props, button } = render();
    click(button("Previous match"));
    click(button("Next match"));
    click(button("Close find"));
    expect(props.onStep.mock.calls).toEqual([[-1], [1]]);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("keeps the caret in the field when a button is pressed", () => {
    const { button } = render();
    for (const label of ["Previous match", "Next match", "Close find"]) {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      dispatch(button(label), down);
      expect(down.defaultPrevented).toBe(true);
    }
  });

  it("reports what is typed", () => {
    const { props, field } = render();
    type(field, "error");
    expect(props.onQuery).toHaveBeenCalledWith("error");
  });

  it("takes focus when it opens and again when the shortcut is pressed", () => {
    const { props, field } = render(1, "needle");
    expect(document.activeElement).toBe(field);
    field.blur();
    expect(document.activeElement).not.toBe(field);
    view!.rerender(<TerminalSearch {...props} focusToken={2} />);
    expect(document.activeElement).toBe(field);
  });
});
