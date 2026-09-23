import { describe, expect, it } from "vitest";
import { routineFace } from "./routineCard";
import type { Routine, RoutineRun } from "./routines";

const run = (status: RoutineRun["status"]): RoutineRun => ({
  id: status,
  startedAt: 0,
  finishedAt: 0,
  status,
  trigger: "schedule",
});

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    sessionId: "s1",
    name: "Morning digest",
    enabled: true,
    prompt: "Summarize the inbox.\n\nThen file anything urgent.",
    schedule: JSON.stringify({ kind: "daily", hour: 9, minute: 5, days: [1, 2, 3, 4, 5] }),
    lastRunAt: null,
    nextRunAt: null,
    runs: [],
    createdBy: null,
    ...patch,
  };
}

describe("routineFace", () => {
  it("reads the name, the prompt's first paragraph and the schedule", () => {
    expect(routineFace(routine())).toEqual({
      title: "Morning digest",
      description: "Summarize the inbox.",
      schedule: "Weekdays at 09:05",
      paused: false,
      failed: false,
    });
  });

  it("names an unnamed routine", () => {
    expect(routineFace(routine({ name: "" })).title).toBe("Untitled routine");
  });

  it("describes an unreadable schedule as the default one", () => {
    expect(routineFace(routine({ schedule: "not json" })).schedule).toBe("Every day at 09:00");
  });

  it("warns when the latest run failed", () => {
    expect(routineFace(routine({ runs: [run("error"), run("ok")] })).failed).toBe(true);
  });

  it("does not warn over an older failure", () => {
    expect(routineFace(routine({ runs: [run("ok"), run("error")] })).failed).toBe(false);
  });

  it("says paused, and not failed, for a disabled routine", () => {
    const face = routineFace(routine({ enabled: false, runs: [run("error")] }));
    expect(face.paused).toBe(true);
    expect(face.failed).toBe(false);
  });
});
