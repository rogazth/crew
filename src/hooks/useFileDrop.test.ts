// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../test/dom";
import { renderHook } from "../test/renderHook";
import { useFileDrop } from "./useFileDrop";

type Rect = { left: number; top: number; width: number; height: number };

/** A pane laid out at `rect`; happy-dom has no layout, so the box is stubbed. */
function pane(rect: Rect, visible = true) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  Object.defineProperty(el, "offsetParent", { get: () => (visible ? document.body : null) });
  const { left, top, width, height } = rect;
  el.getBoundingClientRect = () =>
    ({ ...rect, x: left, y: top, right: left + width, bottom: top + height }) as DOMRect;
  return el;
}

/** A drag event as the OS delivers it, carrying files named `names`. */
function drag(type: string, x: number, y: number, names: string[] = ["a.png"]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const files = names.map((name) => ({ name }));
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    relatedTarget: { value: null },
    dataTransfer: { value: { types: ["Files"], files } },
  });
  return event;
}

const over = (x: number, y: number) => dispatch(window, drag("dragover", x, y));
const drop = (x: number, y: number, names?: string[]) => dispatch(window, drag("drop", x, y, names));
const leave = () => dispatch(window, drag("dragleave", 0, 0));

function mountDrop(el: HTMLElement | null, onDrop = vi.fn()) {
  const ref = { current: el };
  const hook = renderHook(
    (props: { onDrop: (paths: string[]) => void }) => useFileDrop(ref, props.onDrop),
    { onDrop },
  );
  return { hook, onDrop };
}

describe("useFileDrop", () => {
  beforeEach(() => {
    const pathForFile = (file: File) => (file.name ? `/drop/${file.name}` : "");
    window.crewHost = { pathForFile } as NonNullable<typeof window.crewHost>;
  });

  afterEach(() => {
    delete window.crewHost;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("is not hovered at rest", () => {
    const { hook } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    expect(hook.result.current).toBe(false);
    hook.unmount();
  });

  it("reports files hovering the pane until they move off it or leave", () => {
    const { hook } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    over(50, 50);
    expect(hook.result.current).toBe(true);
    over(150, 50);
    expect(hook.result.current).toBe(false);
    over(10, 10);
    expect(hook.result.current).toBe(true);
    leave();
    expect(hook.result.current).toBe(false);
    hook.unmount();
  });

  it("hands dropped paths to the pane under the pointer and clears the hover", () => {
    const { hook, onDrop } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    over(50, 50);
    drop(50, 50, ["a.png", "notes.md"]);
    expect(onDrop).toHaveBeenCalledWith(["/drop/a.png", "/drop/notes.md"]);
    expect(hook.result.current).toBe(false);
    hook.unmount();
  });

  it("ignores a drop outside the pane", () => {
    const { hook, onDrop } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    drop(100, 100);
    expect(onDrop).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("routes each drop to the pane it lands on", () => {
    const left = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    const right = mountDrop(pane({ left: 100, top: 0, width: 100, height: 100 }));
    over(150, 50);
    expect([left.hook.result.current, right.hook.result.current]).toEqual([false, true]);
    over(50, 50);
    expect([left.hook.result.current, right.hook.result.current]).toEqual([true, false]);
    drop(150, 50);
    expect(left.onDrop).not.toHaveBeenCalled();
    expect(right.onDrop).toHaveBeenCalledWith(["/drop/a.png"]);
    left.hook.unmount();
    right.hook.unmount();
  });

  it("skips a pane kept alive in a background tab", () => {
    const { hook, onDrop } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }, false));
    over(50, 50);
    expect(hook.result.current).toBe(false);
    drop(50, 50);
    expect(onDrop).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("skips a pane whose ref is empty", () => {
    const { hook, onDrop } = mountDrop(null);
    over(50, 50);
    drop(50, 50);
    expect(hook.result.current).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("calls the latest handler it was given", () => {
    const { hook, onDrop } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    const next = vi.fn();
    hook.rerender({ onDrop: next });
    drop(50, 50);
    expect(onDrop).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(["/drop/a.png"]);
    hook.unmount();
  });

  it("does not call the handler when no dropped file has a path", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { hook, onDrop } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    drop(50, 50, [""]);
    expect(onDrop).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("stops receiving drops once unmounted", () => {
    const { hook, onDrop } = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    over(50, 50);
    hook.unmount();
    drop(50, 50);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("lets the pane beneath take the hover after the hovered one unmounts", () => {
    const below = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    const above = mountDrop(pane({ left: 0, top: 0, width: 100, height: 100 }));
    over(50, 50);
    expect([below.hook.result.current, above.hook.result.current]).toEqual([false, true]);
    above.hook.unmount();
    over(50, 50);
    expect(below.hook.result.current).toBe(true);
    below.hook.unmount();
  });
});
