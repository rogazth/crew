// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "../test/renderHook";
import { click, mount, press, type Mounted } from "../test/dom";
import { ConfirmDialog, type Confirm } from "./ConfirmDialog";

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

async function render(onConfirm: Confirm["onConfirm"] = vi.fn()) {
  const order: string[] = [];
  const confirm = vi.fn(() => {
    order.push("confirm");
    return onConfirm();
  });
  const onClose = vi.fn(() => order.push("close"));
  view = mount(
    <ConfirmDialog
      confirm={{ title: "Delete agent?", description: "It cannot be undone.", action: "Delete", onConfirm: confirm }}
      onClose={onClose}
    />,
  );
  // The dialog opens through a portal and moves focus on the next frame.
  await act(async () => {});
  return { onConfirm: confirm, onClose, order };
}

const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.startsWith(text))!;

describe("ConfirmDialog", () => {
  it("runs the action, then closes, on the action button", async () => {
    const { onConfirm, onClose, order } = await render();
    click(button("Delete"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(order).toEqual(["confirm", "close"]);
  });

  it("runs the action on Enter", async () => {
    const { onConfirm, onClose } = await render();
    expect(press(button("Delete"), "Enter")).toBe(true);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("runs the action on Enter from anywhere in the dialog", async () => {
    const { onConfirm } = await render();
    press(button("Cancel"), "Enter");
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("closes without running the action on Cancel", async () => {
    const { onConfirm, onClose } = await render();
    click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes without running the action on Escape", async () => {
    const { onConfirm, onClose } = await render();
    press(document.activeElement ?? document.body, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes at once, without waiting for a slow action", async () => {
    const { onClose } = await render(() => new Promise<void>(() => {}));
    click(button("Delete"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores other keys", async () => {
    const { onConfirm, onClose } = await render();
    press(button("Delete"), "a");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks nothing without a confirmation", () => {
    const onClose = vi.fn();
    view = mount(<ConfirmDialog confirm={null} onClose={onClose} />);
    press(document.body, "Escape");
    expect(onClose).not.toHaveBeenCalled();
  });
});
