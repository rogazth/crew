import { describe, expect, it } from "vitest";
import type { RoutineDraft } from "./routines";
import { routineValid, runFailure, withAgentFrom } from "./routineEditor";
import type { Session } from "./types";

const DRAFT: RoutineDraft = {
  key: "k",
  sessionId: "a1",
  name: "Digest",
  enabled: true,
  prompt: "Summarize the night",
  schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
  runs: [],
};

function agent(id: string): Session {
  return {
    id,
    workspaceId: "w",
    kind: "agent",
    name: id,
    provider: "claude",
    model: "",
    providerSessionId: null,
    description: "",
    notifications: true,
    autonomy: "ask",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("routineValid", () => {
  it("accepts a titled routine with instructions and an agent", () => {
    expect(routineValid(DRAFT)).toBe(true);
  });

  it("refuses a blank title, blank instructions or no agent", () => {
    expect(routineValid({ ...DRAFT, name: "   " })).toBe(false);
    expect(routineValid({ ...DRAFT, prompt: "\n\t" })).toBe(false);
    expect(routineValid({ ...DRAFT, sessionId: "" })).toBe(false);
  });

  it("checks the expression only when the schedule is a cron", () => {
    expect(routineValid({ ...DRAFT, schedule: { kind: "cron", expression: "0 9 * * 1" } })).toBe(true);
    expect(routineValid({ ...DRAFT, schedule: { kind: "cron", expression: "every monday" } })).toBe(false);
    expect(routineValid({ ...DRAFT, schedule: { kind: "interval", minutes: 30 } })).toBe(true);
  });
});

describe("withAgentFrom", () => {
  it("keeps the agent when the workspace has it", () => {
    const draft = { ...DRAFT, sessionId: "a2" };
    expect(withAgentFrom(draft, [agent("a1"), agent("a2")])).toBe(draft);
  });

  it("hands the routine to the workspace's first agent otherwise", () => {
    expect(withAgentFrom({ ...DRAFT, sessionId: "gone" }, [agent("b1"), agent("b2")]).sessionId).toBe("b1");
  });

  it("clears the agent when the workspace has none", () => {
    expect(withAgentFrom(DRAFT, []).sessionId).toBe("");
  });
});

describe("runFailure", () => {
  it("shows an error's message and stringifies anything else", () => {
    expect(runFailure(new Error("routine is gone"))).toBe("routine is gone");
    expect(runFailure(42)).toBe("42");
  });
});
