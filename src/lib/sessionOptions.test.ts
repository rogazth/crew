import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import { applyFor, modePresses, nextAccess, type Launched } from "./sessionOptions";

const running: Launched = { model: "claude-opus-5-5", effort: "", serviceTier: "", access: "ask", bypass: false };
const row: Pick<Session, "provider" | "model" | "effort" | "autonomy"> = { provider: "claude", model: "claude-opus-5-5", effort: "", autonomy: "ask" };

describe("applyFor", () => {
  it("leaves a CLI alone that runs what the row says", () => {
    expect(applyFor(row, running)).toEqual({ kind: "none" });
    expect(applyFor(row, null)).toEqual({ kind: "none" });
  });

  it("relaunches for a model, an effort or a service tier, which the CLIs' own commands would save as the user's default", () => {
    expect(applyFor({ ...row, model: "claude-sonnet-5" }, running)).toEqual({ kind: "relaunch" });
    expect(applyFor({ ...row, effort: "high" }, running)).toEqual({ kind: "relaunch" });
    expect(applyFor({ ...row, serviceTier: "fast" }, running)).toEqual({ kind: "relaunch" });
  });

  it("walks Claude's access with ⇧Tab, and relaunches only into or out of full", () => {
    expect(applyFor({ ...row, autonomy: "edits" }, running)).toEqual({ kind: "keys", presses: 1 });
    expect(applyFor({ ...row, autonomy: "auto" }, running)).toEqual({ kind: "keys", presses: 3 });
    expect(applyFor({ ...row, autonomy: "ask" }, { ...running, access: "auto" })).toEqual({ kind: "keys", presses: 1 });
    expect(applyFor({ ...row, autonomy: "full" }, running)).toEqual({ kind: "relaunch" });
    expect(applyFor({ ...row, provider: "codex", autonomy: "auto" }, running)).toEqual({ kind: "relaunch" });
  });

  it("leaves a bypassed CLI's access to Settings", () => {
    expect(applyFor({ ...row, autonomy: "edits" }, { ...running, bypass: true })).toEqual({ kind: "none" });
  });
});

describe("modePresses", () => {
  it("counts through plan, which has no chip", () => {
    expect(modePresses("edits", "auto")).toBe(2);
    expect(modePresses("ask", "full")).toBeNull();
  });
});

describe("nextAccess", () => {
  it("cycles the provider's modes short of full", () => {
    expect(nextAccess("ask", ["ask", "edits", "auto", "full"])).toBe("edits");
    expect(nextAccess("auto", ["ask", "edits", "auto", "full"])).toBe("ask");
    expect(nextAccess("full", ["ask", "edits", "auto", "full"])).toBe("ask");
    expect(nextAccess("ask", ["ask", "full"])).toBeNull();
  });
});
