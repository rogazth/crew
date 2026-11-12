import { describe, expect, it } from "vitest";
import { applyHeld, holdOrder } from "./heldOrder";

type Row = { id: string; name?: string };
type G = { key: string; label?: string; sessions: Row[] };

const g = (key: string, ...ids: string[]): G => ({ key, label: key, sessions: ids.map((id) => ({ id })) });
const shape = (groups: G[]) => groups.map((group) => `${group.key}:${group.sessions.map((s) => s.id).join(",")}`);

describe("applyHeld", () => {
  it("keeps rows where they stood when the live order moves them", () => {
    const held = holdOrder([g("running", "a", "b"), g("idle", "c", "d")]);
    expect(shape(applyHeld([g("running", "b", "d"), g("idle", "c", "a")], held, true))).toEqual(["running:a,b", "idle:c,d"]);
  });

  it("shows what a held row says now", () => {
    const held = holdOrder([g("all", "a", "b")]);
    const live = [{ key: "all", sessions: [{ id: "b" }, { id: "a", name: "renamed" }] }];
    expect(applyHeld(live, held, true)[0]!.sessions).toEqual([{ id: "a", name: "renamed" }, { id: "b" }]);
  });

  it("drops a row that is gone and puts a new one at the top of its group", () => {
    const held = holdOrder([g("running", "a"), g("idle", "c", "d")]);
    expect(shape(applyHeld([g("running", "a"), g("idle", "e", "d")], held, true))).toEqual(["running:a", "idle:e,d"]);
  });

  it("keeps a group the live list emptied while its rows stay in it", () => {
    const held = holdOrder([g("running", "a"), g("idle", "c")]);
    const out = applyHeld([g("idle", "a", "c")], held, true);
    expect(shape(out)).toEqual(["running:a", "idle:c"]);
    expect(out[0]!.label).toBe("running");
  });

  it("lets a gone group go when only emptied ones are kept, its rows where they fall now", () => {
    const held = holdOrder([g("tree:a", "a"), g("tree:main", "c")]);
    expect(shape(applyHeld([g("tree:main", "a", "c")], held, false))).toEqual(["tree:main:a,c"]);
  });

  it("drops a held group with nothing left in it", () => {
    const held = holdOrder([g("running", "a"), g("idle", "c")]);
    expect(shape(applyHeld([g("idle", "c")], held, true))).toEqual(["idle:c"]);
  });

  it("brings in a new group after the one it follows", () => {
    const held = holdOrder([g("needs", "a"), g("idle", "c")]);
    expect(shape(applyHeld([g("needs", "a"), g("running", "n"), g("idle", "c")], held, true))).toEqual(["needs:a", "running:n", "idle:c"]);
    expect(shape(applyHeld([g("first", "n"), g("needs", "a"), g("idle", "c")], held, true))).toEqual(["first:n", "needs:a", "idle:c"]);
  });
});
