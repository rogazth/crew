// @vitest-environment happy-dom
import { useDragDropManager } from "@dnd-kit/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../test/dom";
import { act } from "../test/renderHook";
import { SortableItem, SortableList } from "./SortableList";

type Manager = NonNullable<ReturnType<typeof useDragDropManager>>;

let view: Mounted | null = null;
let manager: Manager | null = null;

beforeEach(() => {
  // happy-dom has no Web Animations; dnd-kit asks for running animations when a drop settles.
  if (!("getAnimations" in document)) Object.assign(document, { getAnimations: () => [] });
});

afterEach(() => {
  view?.unmount();
  view = null;
  manager = null;
});

/** Hands the test the list's own drag manager: happy-dom has no layout, so a pointer drag cannot find its targets. */
function Grab({ onManager }: { onManager: (manager: Manager | null) => void }) {
  const found = useDragDropManager();
  useEffect(() => onManager(found), [found, onManager]);
  return null;
}

const keep = (found: Manager | null) => {
  manager = found;
};

async function render(ids: string[], disabled = false) {
  const onReorder = vi.fn();
  view = mount(
    <SortableList ids={ids} disabled={disabled} onReorder={onReorder}>
      <Grab onManager={keep} />
      {ids.map((id, index) => (
        <SortableItem key={id} id={id} index={index} group="g">
          <span>{id}</span>
        </SortableItem>
      ))}
    </SortableList>,
  );
  await act(async () => {});
  return onReorder;
}

/** Picks `source` up, holds it over `target`, and lets go. */
async function drag(source: string, target: string, canceled = false) {
  await act(async () => {
    manager!.actions.start({ source, coordinates: { x: 0, y: 0 } });
  });
  await act(async () => {
    await manager!.actions.setDropTarget(target);
  });
  await act(async () => {
    manager!.actions.stop({ canceled });
  });
}

describe("SortableList", () => {
  it("persists the new order on drop", async () => {
    const onReorder = await render(["a", "b", "c"]);
    await drag("a", "c");
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(["b", "c", "a"]);
  });

  it("persists an upward move", async () => {
    const onReorder = await render(["a", "b", "c"]);
    await drag("c", "a");
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(["c", "a", "b"]);
  });

  it("persists nothing for a drop in place", async () => {
    const onReorder = await render(["a", "b", "c"]);
    await drag("b", "b");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("persists nothing for a cancelled drag", async () => {
    const onReorder = await render(["a", "b", "c"]);
    await drag("a", "c", true);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("persists nothing while the list is locked, even if a row still drags", async () => {
    const onReorder = await render(["a", "b", "c"], true);
    await drag("a", "c");
    expect(onReorder).not.toHaveBeenCalled();
  });
});
