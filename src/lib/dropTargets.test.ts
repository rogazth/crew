import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDragDrop } from "./host";

const host = vi.hoisted(() => ({
  handler: null as ((event: HostDragDrop) => void) | null,
  onDragDrop: vi.fn(),
}));

vi.mock("./host", () => ({ onDragDrop: host.onDragDrop }));

type Rect = { left: number; top: number; right: number; bottom: number };

/** A target laid out at `rect` in CSS pixels; `visible: false` is a background tab. */
function target(rect: Rect, { visible = true } = {}) {
  const el = { offsetParent: visible ? {} : null, getBoundingClientRect: () => rect } as unknown as HTMLElement;
  return { el: () => el, onDrop: vi.fn(), onOver: vi.fn() };
}

function send(event: HostDragDrop) {
  if (!host.handler) throw new Error("nothing is listening for drops");
  host.handler(event);
}

const over = (x: number, y: number) => send({ type: "over", position: { x, y } });
const drop = (x: number, y: number, paths: string[]) => send({ type: "drop", position: { x, y }, paths });

const LEFT = { left: 0, top: 0, right: 100, bottom: 100 };
const RIGHT = { left: 100, top: 0, right: 200, bottom: 100 };

async function load() {
  return import("./dropTargets");
}

beforeEach(() => {
  vi.resetModules();
  host.handler = null;
  host.onDragDrop.mockReset();
  host.onDragDrop.mockImplementation((handler: (event: HostDragDrop) => void) => {
    host.handler = handler;
  });
  vi.stubGlobal("window", { devicePixelRatio: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerDropTarget", () => {
  it("starts listening to the host once, on the first registration", async () => {
    const { registerDropTarget } = await load();
    expect(host.onDragDrop).not.toHaveBeenCalled();
    registerDropTarget(target(LEFT));
    registerDropTarget(target(RIGHT));
    expect(host.onDragDrop).toHaveBeenCalledTimes(1);
  });

  it("highlights the target under the pointer and moves the highlight with it", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    const right = target(RIGHT);
    registerDropTarget(left);
    registerDropTarget(right);

    send({ type: "enter", position: { x: 10, y: 10 } });
    expect(left.onOver.mock.calls).toEqual([[true]]);
    over(20, 20);
    expect(left.onOver).toHaveBeenCalledTimes(1);

    over(150, 20);
    expect(left.onOver.mock.calls).toEqual([[true], [false]]);
    expect(right.onOver.mock.calls).toEqual([[true]]);

    over(500, 500);
    expect(right.onOver.mock.calls).toEqual([[true], [false]]);
  });

  it("reads host positions in device pixels", async () => {
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    const right = target(RIGHT);
    registerDropTarget(left);
    registerDropTarget(right);
    over(150, 50);
    expect(left.onOver).toHaveBeenCalledWith(true);
    expect(right.onOver).not.toHaveBeenCalled();
  });

  it("treats a missing device pixel ratio as 1", async () => {
    vi.stubGlobal("window", { devicePixelRatio: 0 });
    const { registerDropTarget } = await load();
    const right = target(RIGHT);
    registerDropTarget(right);
    over(150, 50);
    expect(right.onOver).toHaveBeenCalledWith(true);
  });

  it("includes the left and top edges and excludes the right and bottom ones", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    registerDropTarget(left);
    over(0, 0);
    expect(left.onOver.mock.calls).toEqual([[true]]);
    over(100, 50);
    over(50, 100);
    expect(left.onOver.mock.calls).toEqual([[true], [false]]);
  });

  it("skips targets in background tabs and targets without an element", async () => {
    const { registerDropTarget } = await load();
    const hidden = target(LEFT, { visible: false });
    const gone = { el: () => null, onDrop: vi.fn(), onOver: vi.fn() };
    registerDropTarget(hidden);
    registerDropTarget(gone);
    over(50, 50);
    drop(50, 50, ["/tmp/a.png"]);
    expect(hidden.onOver).not.toHaveBeenCalled();
    expect(hidden.onDrop).not.toHaveBeenCalled();
    expect(gone.onDrop).not.toHaveBeenCalled();
  });

  it("gives an overlapping drop to the target registered last", async () => {
    const { registerDropTarget } = await load();
    const outer = target({ left: 0, top: 0, right: 400, bottom: 400 });
    const inner = target(LEFT);
    registerDropTarget(outer);
    registerDropTarget(inner);
    drop(50, 50, ["/tmp/a.png"]);
    expect(inner.onDrop).toHaveBeenCalledWith(["/tmp/a.png"]);
    expect(outer.onDrop).not.toHaveBeenCalled();
  });

  it("hands dropped paths to the target under the drop and clears the highlight", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    registerDropTarget(left);
    over(50, 50);
    drop(50, 50, ["/tmp/a.png", "/tmp/b.txt"]);
    expect(left.onDrop).toHaveBeenCalledWith(["/tmp/a.png", "/tmp/b.txt"]);
    expect(left.onOver.mock.calls).toEqual([[true], [false]]);
  });

  it("drops nothing when no path came through, but still clears the highlight", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    registerDropTarget(left);
    over(50, 50);
    drop(50, 50, []);
    expect(left.onDrop).not.toHaveBeenCalled();
    expect(left.onOver.mock.calls).toEqual([[true], [false]]);
  });

  it("drops nothing outside every target", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    registerDropTarget(left);
    drop(300, 300, ["/tmp/a.png"]);
    expect(left.onDrop).not.toHaveBeenCalled();
    expect(left.onOver).not.toHaveBeenCalled();
  });

  it("clears the highlight when the drag leaves the window", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    registerDropTarget(left);
    over(50, 50);
    send({ type: "leave" });
    expect(left.onOver.mock.calls).toEqual([[true], [false]]);
  });

  it("clears the highlight of a target that unregisters mid-drag and stops offering it", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    const unregister = registerDropTarget(left);
    over(50, 50);
    unregister();
    expect(left.onOver.mock.calls).toEqual([[true], [false]]);
    over(60, 60);
    drop(60, 60, ["/tmp/a.png"]);
    expect(left.onOver).toHaveBeenCalledTimes(2);
    expect(left.onDrop).not.toHaveBeenCalled();
  });

  it("leaves another target's highlight alone when an idle target unregisters", async () => {
    const { registerDropTarget } = await load();
    const left = target(LEFT);
    const right = target(RIGHT);
    registerDropTarget(left);
    const unregisterRight = registerDropTarget(right);
    over(50, 50);
    unregisterRight();
    expect(right.onOver).not.toHaveBeenCalled();
    expect(left.onOver.mock.calls).toEqual([[true]]);
  });
});
