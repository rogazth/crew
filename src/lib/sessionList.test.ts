import { describe, expect, it } from "vitest";
import { applyUpdated, droppedOnReload, mergeReloaded } from "./sessionList";
import type { Session } from "./types";

const row = (id: string, fields: Partial<Session> = {}) => ({ id, name: id, status: "idle", ...fields }) as Session;

describe("mergeReloaded", () => {
  it("adds sessions the daemon has that the window did not", () => {
    const merged = mergeReloaded([row("a")], [row("a"), row("b")], new Set());
    expect(merged.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("drops sessions the daemon no longer lists", () => {
    expect(mergeReloaded([row("a"), row("b")], [row("b")], new Set()).map((s) => s.id)).toEqual(["b"]);
  });

  it("keeps the window's status but takes the daemon's other fields", () => {
    const [merged] = mergeReloaded([row("a", { status: "working", name: "old" })], [row("a", { status: "idle", name: "new" })], new Set());
    expect(merged).toMatchObject({ status: "working", name: "new" });
  });

  it("follows the daemon's order", () => {
    expect(mergeReloaded([row("a"), row("b")], [row("b"), row("a")], new Set()).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("keeps a session made while the read was in flight", () => {
    const merged = mergeReloaded([row("a"), row("new")], [row("a")], new Set(["new"]));
    expect(merged.map((s) => s.id)).toEqual(["a", "new"]);
  });
});

describe("droppedOnReload", () => {
  it("names the held sessions the daemon let go, sparing ones made meanwhile", () => {
    expect(droppedOnReload([row("a"), row("gone"), row("new")], [row("a")], new Set(["new"]))).toEqual(["gone"]);
  });
});

describe("applyUpdated", () => {
  it("takes the description a bot rewrote and keeps the window's status", () => {
    const held = row("a", { status: "working", description: "old" });
    expect(applyUpdated(held, row("a", { status: "idle", description: "new" }))).toMatchObject({
      status: "working",
      description: "new",
    });
  });

  it("takes how far a child got and what the user read of it", () => {
    const lastEvent = { kind: "failed" as const, at: 5, cursor: 7 };
    const updated = applyUpdated(row("a", { cursor: 3, userSeen: 3 }), row("a", { cursor: 7, userSeen: 3, lastEvent }));
    expect(updated).toMatchObject({ cursor: 7, userSeen: 3, lastEvent });
  });
});
