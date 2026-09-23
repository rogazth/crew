// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

// Icons are presentation, and the barrel costs over a second to import.
vi.mock("@phosphor-icons/react", () => new Proxy({}, { has: () => true, get: (_, key) => (key === "then" ? undefined : () => null) }));

import { click, mount, press, type Mounted } from "../test/dom";
import { TerminalMenu } from "./TerminalMenu";

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

function render(hasSelection: boolean) {
  const handlers = {
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    onSelectAll: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
  };
  view = mount(<TerminalMenu point={{ x: 0, y: 0 }} hasSelection={hasSelection} {...handlers} />);
  return handlers;
}

const item = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.startsWith(label))!;

describe("TerminalMenu", () => {
  it.each([
    ["Copy", "onCopy"],
    ["Paste", "onPaste"],
    ["Select All", "onSelectAll"],
    ["Clear", "onClear"],
  ] as const)("runs %s, then closes", (label, handler) => {
    const handlers = render(true);
    click(item(label));
    expect(handlers[handler]).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers[handler].mock.invocationCallOrder[0]!).toBeLessThan(handlers.onClose.mock.invocationCallOrder[0]!);
  });

  it("cannot copy without a selection", () => {
    const handlers = render(false);
    click(item("Copy"));
    expect(handlers.onCopy).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape without running anything", () => {
    const handlers = render(true);
    press(window, "Escape");
    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers.onCopy).not.toHaveBeenCalled();
    expect(handlers.onPaste).not.toHaveBeenCalled();
  });
});
