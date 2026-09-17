import { describe, expect, it } from "vitest";
import type { SearchHit } from "./protocol";
import { rangeStart, roleLabel, snippetRuns } from "./search";

const OPEN = "";
const CLOSE = "";

describe("snippetRuns", () => {
  it("splits a marked hit out of its line", () => {
    expect(snippetRuns(`deploy the ${OPEN}marketplace${CLOSE} branch`)).toEqual([
      { text: "deploy the ", hit: false },
      { text: "marketplace", hit: true },
      { text: " branch", hit: false },
    ]);
  });

  it("handles several hits in one line", () => {
    const runs = snippetRuns(`${OPEN}a${CLOSE} and ${OPEN}b${CLOSE}`);
    expect(runs.filter((run) => run.hit).map((run) => run.text)).toEqual(["a", "b"]);
  });

  it("leaves an unmarked snippet as one run", () => {
    expect(snippetRuns("nothing marked")).toEqual([{ text: "nothing marked", hit: false }]);
  });

  it("does not lose text when a marker is unpaired", () => {
    const runs = snippetRuns(`half ${OPEN}open`);
    expect(runs.map((run) => run.text).join("")).toContain("open");
  });

  it("keeps agent text that looks like markup intact", () => {
    const runs = snippetRuns(`use ${OPEN}<b>${CLOSE} tags`);
    expect(runs[1]).toEqual({ text: "<b>", hit: true });
  });
});

describe("rangeStart", () => {
  const now = new Date("2026-09-17T14:30:00").getTime();

  it("has no floor for any time", () => {
    expect(rangeStart("any", now)).toBeUndefined();
  });

  it("starts today at midnight, not 24 hours ago", () => {
    const start = rangeStart("today", now);
    expect(new Date(start ?? 0).getHours()).toBe(0);
    expect(start).toBeLessThan(now);
    expect(now - (start ?? 0)).toBeLessThan(86_400_000);
  });

  it("counts a week and a month back from now", () => {
    expect(now - (rangeStart("week", now) ?? 0)).toBe(7 * 86_400_000);
    expect(now - (rangeStart("month", now) ?? 0)).toBe(30 * 86_400_000);
  });
});

describe("roleLabel", () => {
  it("calls a user turn yours", () => {
    const hit = { role: "user" } as SearchHit;
    expect(roleLabel(hit)).toBe("You");
  });

  it("names every role", () => {
    const roles: SearchHit["role"][] = [
      "user",
      "assistant",
      "reasoning",
      "tool",
      "approval",
      "question",
      "system",
    ];
    for (const role of roles) {
      expect(roleLabel({ role } as SearchHit)).not.toBe("");
    }
  });
});
