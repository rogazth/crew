import { describe, expect, it } from "vitest";
import { composerHints } from "./composerHints";

const line = (hints: ReturnType<typeof composerHints>) => hints.map(({ key, does }) => `${key} ${does}`).join(" · ");

describe("composerHints", () => {
  it("says nothing while the session is idle", () => {
    expect(composerHints({ working: false, escBack: false })).toEqual([]);
    expect(composerHints({ working: false, escBack: true })).toEqual([]);
  });

  it("says nothing more while a turn runs: sending is sending, and no key stops it", () => {
    expect(composerHints({ working: true, escBack: false })).toEqual([]);
  });

  it("says esc goes back in a thread with a turn running", () => {
    expect(line(composerHints({ working: true, escBack: true }))).toBe("esc back");
  });

  it("says ⇧Tab steps the effort, idle or not, when there are levels to step", () => {
    expect(line(composerHints({ working: false, escBack: false, stepsEffort: true }))).toBe("⇧Tab effort");
    expect(line(composerHints({ working: true, escBack: true, stepsEffort: true }))).toBe("esc back · ⇧Tab effort");
  });
});
