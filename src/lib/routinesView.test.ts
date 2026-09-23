import { describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import type { RoutineDraft } from "./routines";
import {
  cardWorkspace,
  deleteConfirm,
  emptyLine,
  filterRoutines,
  initialOpen,
  newRoutineOpen,
} from "./routinesView";
import type { Session, Workspace } from "./types";

function entry(id: string, enabled: boolean, workspaceId = "w1") {
  return { routine: { id, name: `Routine ${id}`, enabled }, session: { name: "Ada", workspaceId } };
}

const ENTRIES = [entry("r1", true), entry("r2", false), entry("r3", true)];
const WORKSPACES: Workspace[] = [
  { id: "w1", name: "crew", path: "/w1", createdAt: 0 },
  { id: "w2", name: "site", path: "/w2", createdAt: 0 },
];

describe("filterRoutines", () => {
  it("shows every routine under all", () => {
    expect(filterRoutines(ENTRIES, "all").map((e) => e.routine.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("shows the enabled ones under active and the rest under paused", () => {
    expect(filterRoutines(ENTRIES, "active").map((e) => e.routine.id)).toEqual(["r1", "r3"]);
    expect(filterRoutines(ENTRIES, "paused").map((e) => e.routine.id)).toEqual(["r2"]);
  });

  it("shows nothing while the list is loading", () => {
    expect(filterRoutines(null, "all")).toEqual([]);
  });
});

describe("emptyLine", () => {
  it("names the filter when routines exist but none match", () => {
    expect(emptyLine(true, true, "paused")).toBe("No paused routines.");
  });

  it("explains routines when there are none yet", () => {
    expect(emptyLine(false, true, "all")).toMatch(/^No routines yet\./);
  });

  it("asks for an agent first when there is none to run one", () => {
    expect(emptyLine(false, false, "all")).toMatch(/Create an agent first\.$/);
  });
});

describe("cardWorkspace", () => {
  it("says nothing for a routine in the workspace on screen", () => {
    expect(cardWorkspace(entry("r1", true, "w1"), "w1", WORKSPACES)).toBeNull();
  });

  it("names another workspace", () => {
    expect(cardWorkspace(entry("r1", true, "w2"), "w1", WORKSPACES)).toBe("site");
  });

  it("says nothing when that workspace is unknown", () => {
    expect(cardWorkspace(entry("r1", true, "gone"), "w1", WORKSPACES)).toBeNull();
  });
});

const DRAFT: RoutineDraft = {
  key: "k",
  sessionId: "a1",
  name: "",
  enabled: true,
  prompt: "",
  schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
  runs: [],
};

describe("initialOpen", () => {
  it("opens a handed-in draft in the active workspace", () => {
    expect(initialOpen(DRAFT, "w1")).toEqual({ kind: "new", draft: DRAFT, workspaceId: "w1" });
  });

  it("opens the list without a draft or without a workspace", () => {
    expect(initialOpen(null, "w1")).toBeNull();
    expect(initialOpen(DRAFT, null)).toBeNull();
  });
});

describe("newRoutineOpen", () => {
  const agents = [{ id: "a1" }, { id: "a2" }] as Session[];

  it("starts a blank draft on the first agent", () => {
    const open = newRoutineOpen(agents, "w1");
    expect(open).toMatchObject({ kind: "new", workspaceId: "w1", draft: { sessionId: "a1", name: "", prompt: "" } });
  });

  it("does nothing without an agent or a workspace", () => {
    expect(newRoutineOpen([], "w1")).toBeNull();
    expect(newRoutineOpen(agents, null)).toBeNull();
  });
});

describe("deleteConfirm", () => {
  it("names the routine and its agent", () => {
    const confirm = deleteConfirm(entry("r1", true), vi.fn(), vi.fn());
    expect(confirm).toMatchObject({
      title: 'Delete routine "Routine r1"?',
      description: "Ada stops running it. Its history goes with it.",
      action: "Delete",
    });
  });

  it("closes the editor before removing the routine, and waits for the removal", async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    const confirm = deleteConfirm(
      entry("r1", true),
      () => order.push("close"),
      (id) => {
        order.push(`remove ${id}`);
        return gate.promise;
      },
    );
    let done = false;
    const running = confirm.onConfirm().then(() => (done = true));
    expect(order).toEqual(["close", "remove r1"]);
    await Promise.resolve();
    expect(done).toBe(false);
    gate.resolve();
    await running;
    expect(done).toBe(true);
  });
});
