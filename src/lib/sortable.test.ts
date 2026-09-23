import { describe, expect, it } from "vitest";
import { droppedOrder, type DropEvent } from "./sortable";

/** A sortable drop as dnd-kit reports it: the dragged row, where it landed, and what it is over. */
function drop(source: string, index: number, target: string, canceled = false): DropEvent {
  return {
    operation: { source: { id: source, index }, target: { id: target }, canceled },
    canceled,
  } as unknown as DropEvent;
}

describe("droppedOrder", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves a row down to where it was dropped", () => {
    expect(droppedOrder(ids, drop("a", 2, "c"))).toEqual(["b", "c", "a", "d"]);
  });

  it("moves a row up to where it was dropped", () => {
    expect(droppedOrder(ids, drop("d", 0, "a"))).toEqual(["d", "a", "b", "c"]);
  });

  it("does not touch the list it was given", () => {
    droppedOrder(ids, drop("a", 3, "d"));
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("persists nothing when the row lands where it started", () => {
    expect(droppedOrder(ids, drop("b", 1, "b"))).toBeNull();
  });

  it("persists nothing for a cancelled drag", () => {
    expect(droppedOrder(ids, drop("a", 2, "c", true))).toBeNull();
  });

  it("persists nothing while the list is locked", () => {
    expect(droppedOrder(ids, drop("a", 2, "c"), true)).toBeNull();
  });

  it("persists nothing when the drop has no target", () => {
    const event = { operation: { source: { id: "a", index: 0 }, target: null, canceled: false }, canceled: false };
    expect(droppedOrder(ids, event as unknown as DropEvent)).toBeNull();
  });
});
