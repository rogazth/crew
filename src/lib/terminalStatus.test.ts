import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_AFTER, SETTLE_WINDOW, TerminalActivity, titleBusy, titleName } from "./terminalStatus";
import type { SessionStatus } from "./types";

function track(initial: SessionStatus = "idle", watched = false) {
  const reported: SessionStatus[] = [];
  const activity = new TerminalActivity(initial, watched, { report: (s) => reported.push(s) });
  return { activity, reported };
}

/** A TUI spinner: output every 100ms for `ms`. */
function spin(activity: TerminalActivity, ms: number) {
  for (let t = 0; t < ms; t += 100) {
    activity.output();
    vi.advanceTimersByTime(100);
  }
}

/** Past the first screen the CLI draws when it starts. */
function started(activity: TerminalActivity) {
  spin(activity, 300);
  vi.advanceTimersByTime(QUIET_AFTER);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("titleBusy", () => {
  it("reads Claude's marks", () => {
    expect(titleBusy("✳ Claude Code")).toBe(false);
    expect(titleBusy("◐ Sleep command test")).toBe(true);
    expect(titleBusy("◑ Sleep command test")).toBe(true);
    expect(titleBusy("⠂ Fix the build")).toBe(true);
  });

  it("says nothing about other titles", () => {
    expect(titleBusy("OpenCode")).toBeNull();
    expect(titleBusy("OC | 400 word story")).toBeNull();
    expect(titleBusy("Cursor Agent")).toBeNull();
    expect(titleBusy("✳")).toBeNull();
    expect(titleBusy("")).toBeNull();
  });
});

describe("titleName", () => {
  it("drops Claude's mark, and nothing else", () => {
    expect(titleName("◐ Sleep command test")).toBe("Sleep command test");
    expect(titleName("✳ Sleep command test")).toBe("Sleep command test");
    expect(titleName("OC | 400 word story")).toBe("OC | 400 word story");
  });
});

describe("TerminalActivity", () => {
  it("does not take the first screen for work", () => {
    const { activity, reported } = track();
    spin(activity, 1200);
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual([]);
  });

  it("works in the background and ends unread", () => {
    const { activity, reported } = track();
    started(activity);
    spin(activity, 3000);
    expect(activity.status).toBe("working");
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual(["working", "done"]);
  });

  it("shows a watched turn as working and ends it read", () => {
    const { activity, reported } = track("idle", true);
    started(activity);
    activity.input();
    vi.advanceTimersByTime(400);
    spin(activity, 2000);
    expect(activity.status).toBe("working");
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual(["working", "idle"]);
  });

  it("stays working through a switch away, with no idle gap", () => {
    const { activity, reported } = track("idle", true);
    started(activity);
    spin(activity, 1000);
    activity.watch(false);
    spin(activity, 3000);
    expect(reported).toEqual(["working"]);
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual(["working", "done"]);
  });

  it("stays working through a switch back", () => {
    const { activity, reported } = track();
    started(activity);
    spin(activity, 1000);
    activity.watch(true);
    spin(activity, 1000);
    expect(reported).toEqual(["working"]);
  });

  it("opening a finished tab reads it", () => {
    const { activity, reported } = track();
    started(activity);
    spin(activity, 1000);
    vi.advanceTimersByTime(QUIET_AFTER);
    activity.watch(true);
    expect(reported).toEqual(["working", "done", "idle"]);
  });

  it("ignores keys echoed back", () => {
    const { activity, reported } = track("idle", true);
    started(activity);
    for (let i = 0; i < 20; i++) {
      activity.input();
      vi.advanceTimersByTime(50);
      activity.output();
      vi.advanceTimersByTime(100);
    }
    expect(reported).toEqual([]);
  });

  it("ignores a lone repaint, like a toast going away", () => {
    const { activity, reported } = track();
    started(activity);
    activity.output();
    vi.advanceTimersByTime(8000);
    activity.output();
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual([]);
  });

  it("ignores the repaint after a tab switch", () => {
    const { activity, reported } = track("idle", true);
    started(activity);
    activity.watch(false);
    spin(activity, SETTLE_WINDOW - 200);
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual([]);
  });

  it("lets a bell hold the slot over the redraw that follows", () => {
    const { activity, reported } = track();
    started(activity);
    spin(activity, 1000);
    activity.bell();
    spin(activity, 500);
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual(["working", "needs-input"]);
    activity.watch(true);
    expect(activity.status).toBe("idle");
  });

  it("trusts Claude's title over output", () => {
    const { activity, reported } = track();
    activity.output();
    activity.title("✳ Claude Code");
    activity.title("◐ Sleep command test");
    // A long tool call: the title keeps spinning, nothing else moves.
    vi.advanceTimersByTime(20_000);
    expect(activity.status).toBe("working");
    activity.watch(true);
    activity.watch(false);
    activity.title("◑ Sleep command test");
    expect(reported).toEqual(["working"]);
    activity.title("✳ Sleep command test");
    activity.output();
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual(["working", "done"]);
  });

  it("lets Claude's title take the slot back once the question is answered", () => {
    const { activity, reported } = track();
    activity.title("✳ Claude Code");
    activity.title("◐ Create a file");
    activity.title("✳ Create a file");
    activity.bell();
    activity.title("◐ Create a file");
    expect(reported).toEqual(["working", "done", "needs-input", "working"]);
  });

  it("clears a stale working left from a closed window", () => {
    const { reported } = track("working");
    expect(reported).toEqual(["idle"]);
  });

  it("keeps an unread flag until the tab is opened", () => {
    const { reported } = track("done");
    expect(reported).toEqual([]);
    expect(track("done", true).reported).toEqual(["idle"]);
  });

  it("reports a failed exit, and the shell after it starts over", () => {
    const { activity, reported } = track();
    started(activity);
    activity.title("✳ Claude Code");
    activity.exit(1);
    expect(reported).toEqual(["error"]);
    spin(activity, 500);
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual(["error"]);
  });
});
