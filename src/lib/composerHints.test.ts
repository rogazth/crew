import { describe, expect, it } from "vitest";
import { composerHints } from "./composerHints";

const line = (hints: ReturnType<typeof composerHints>) => hints.map(({ key, does }) => `${key} ${does}`).join(" · ");

describe("composerHints", () => {
  it("says nothing while the session is idle", () => {
    expect(composerHints({ working: false, escBack: false })).toEqual([]);
    expect(composerHints({ working: false, escBack: true, whileWorking: "steer" })).toEqual([]);
  });

  it("says what esc and ↵ do while a turn runs", () => {
    expect(line(composerHints({ working: true, escBack: false, whileWorking: "steer" }))).toBe(
      "esc stop · ↵ add to the turn · ⌘↵ next turn",
    );
    expect(line(composerHints({ working: true, escBack: false, whileWorking: "queue" }))).toBe("esc stop · ↵ queue");
    expect(line(composerHints({ working: true, escBack: false }))).toBe("esc stop");
  });

  it("says esc goes back in a thread, where it never stops the turn", () => {
    expect(line(composerHints({ working: true, escBack: true, whileWorking: "steer" }))).toBe(
      "esc back · ↵ add to the turn · ⌘↵ next turn",
    );
  });
});
