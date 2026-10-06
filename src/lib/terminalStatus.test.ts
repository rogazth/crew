import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOOK_GRACE, HOOK_LAG, QUIET_AFTER, SETTLE_WINDOW, TerminalActivity, titleBusy, titleName } from "./terminalStatus";
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
    activity.setWatched(false);
    spin(activity, 3000);
    expect(reported).toEqual(["working"]);
    vi.advanceTimersByTime(QUIET_AFTER);
    expect(reported).toEqual(["working", "done"]);
  });

  it("stays working through a switch back", () => {
    const { activity, reported } = track();
    started(activity);
    spin(activity, 1000);
    activity.setWatched(true);
    spin(activity, 1000);
    expect(reported).toEqual(["working"]);
  });

  it("opening a finished tab reads it", () => {
    const { activity, reported } = track();
    started(activity);
    spin(activity, 1000);
    vi.advanceTimersByTime(QUIET_AFTER);
    activity.setWatched(true);
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

  it("notices a turn that starts while the user flips between tabs", () => {
    const { activity, reported } = track();
    started(activity);
    // Every 1.2s: each switch's settle leaves only a short stretch between.
    for (let t = 0; t < 4800; t += 100) {
      if (t % 1200 === 0) activity.setWatched(t % 2400 === 0);
      activity.output();
      vi.advanceTimersByTime(100);
    }
    expect(reported[0]).toBe("working");
  });

  it("ignores the repaint after a tab switch", () => {
    const { activity, reported } = track("idle", true);
    started(activity);
    activity.setWatched(false);
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
    activity.setWatched(true);
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
    activity.setWatched(true);
    activity.setWatched(false);
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

  it("keeps the working of a CLI whose tab closed while it ran, until its hook says the turn ended", () => {
    const reported: SessionStatus[] = [];
    const busy: boolean[] = [];
    const activity = new TerminalActivity("working", false, {
      report: (s) => reported.push(s),
      onBusy: (b) => busy.push(b),
      running: true,
    });
    expect(reported).toEqual([]);
    expect(busy).toEqual([true]);
    activity.hooked(false, false);
    expect(reported).toEqual(["done"]);
  });

  it("keeps an unread flag until the tab is opened", () => {
    const { reported } = track("done");
    expect(reported).toEqual([]);
    expect(track("done", true).reported).toEqual(["idle"]);
  });

  it("once read from its row, is unread again when the process ends unseen", () => {
    const { activity, reported } = track("done");
    activity.read();
    activity.exit(0);
    expect(reported).toEqual(["done"]);
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

  // A failure is news like a finished turn, not a mark the session wears for good.
  it("lets a failure go once the tab is looked at", () => {
    const { activity, reported } = track();
    activity.exit(1);
    activity.setWatched(true);
    expect(reported).toEqual(["error", "idle"]);
    expect(track("error", true).reported).toEqual(["idle"]);
  });

  it("lets a failure go once its row marks it read", () => {
    const { activity, reported } = track("error");
    activity.read();
    activity.exit(1);
    expect(reported).toEqual(["error"]);
  });

  it("does not flag a failure the user watched happen", () => {
    const { activity, reported } = track("idle", true);
    activity.exit(1);
    expect(reported).toEqual([]);
  });

  it("clears a failure once the CLI works again", () => {
    const { activity, reported } = track("error");
    activity.hooked(true, false);
    activity.hooked(false, false);
    expect(reported).toEqual(["working", "done"]);
  });
});

describe("TerminalActivity with hooks", () => {
  it("works from the prompt the hook reports until the one that says it stopped", () => {
    const { activity, reported } = track();
    activity.hooked(true, false);
    expect(reported).toEqual(["working"]);
    activity.hooked(false, false);
    expect(reported).toEqual(["working", "done"]);
  });

  it("needs input out of sight while the CLI asks, and works again once answered", () => {
    const { activity, reported } = track();
    activity.hooked(true, false);
    activity.hooked(true, true);
    // Claude sets its idle mark while it waits; the question still stands.
    activity.title("✳ Claude Code");
    expect(activity.status).toBe("needs-input");
    activity.hooked(true, false);
    expect(reported.at(-1)).toBe("working");
  });

  it("takes a resting title drawn before the prompt's hook for what it is", () => {
    const { activity, reported } = track();
    activity.hooked(true, false);
    // The ✳ a /clear painted, landing after the next prompt's hook.
    activity.title("✳ Claude Code");
    expect(reported).toEqual(["working"]);
    // Esc in the terminal, well into the turn: no hook, the title ends it.
    vi.advanceTimersByTime(HOOK_GRACE);
    activity.title("✳ Claude Code");
    vi.advanceTimersByTime(HOOK_LAG);
    expect(reported).toEqual(["working", "done"]);
  });

  // Claude ends a turn on a build it left running and is woken when the build
  // ends: the turn is over, the session is not, and there is nothing new to read.
  it("runs in the background through a turn that ended on work left there", () => {
    const { activity, reported } = track();
    activity.hooked(true, false);
    vi.advanceTimersByTime(HOOK_GRACE);
    // Claude rests its title as the turn ends, a moment before its Stop hook lands.
    activity.title("✳ Run the build");
    vi.advanceTimersByTime(HOOK_LAG / 4);
    activity.hooked(false, false, true);
    vi.advanceTimersByTime(HOOK_LAG * 2);
    expect(activity.status).toBe("background");
    expect(activity.busy).toBe(false);
    // Resting again while it waits on the build says nothing new.
    activity.title("✳ Run the build");
    vi.advanceTimersByTime(HOOK_LAG * 2);
    expect(activity.status).toBe("background");
    // The build reports back; the turn it starts ends with nothing left running.
    activity.hooked(true, false);
    activity.title("◐ Run the build");
    activity.hooked(false, false);
    expect(reported).toEqual(["working", "background", "working", "done"]);
  });

  it("asks before closing a terminal whose work runs in the background", () => {
    const busy: boolean[] = [];
    const activity = new TerminalActivity("idle", false, { report: () => {}, onBusy: (b) => busy.push(b) });
    activity.hooked(true, false);
    activity.hooked(false, false, true);
    expect(busy.at(-1)).toBe(true);
    activity.hooked(false, false);
    expect(busy.at(-1)).toBe(false);
  });

  // Esc stops the turn the build woke: no Stop runs, the history ends it.
  it("ends a woken turn stopped with Esc, with nothing left in the background", () => {
    const { activity, reported } = track();
    activity.hooked(true, false);
    activity.hooked(false, false, true);
    activity.hooked(true, false);
    vi.advanceTimersByTime(HOOK_GRACE);
    activity.hooked(false, false);
    expect(reported).toEqual(["working", "background", "working", "done"]);
  });

  it("reads a turn left in the background while you watch as such, and idle once it ends", () => {
    const { activity, reported } = track("idle", true);
    activity.hooked(true, false);
    activity.hooked(false, false, true);
    expect(activity.status).toBe("background");
    activity.hooked(false, false);
    expect(reported).toEqual(["working", "background", "idle"]);
  });

  it("finds a terminal left in the background where it was", () => {
    const gone = new TerminalActivity("background", false, { report: () => {}, running: false });
    expect(gone.status).toBe("idle");
    const up = new TerminalActivity("background", false, { report: () => {}, running: true });
    expect(up.status).toBe("background");
  });

  it("stops reading output as work once a hook has spoken", () => {
    const { activity, reported } = track();
    started(activity);
    activity.hooked(false, false);
    spin(activity, 3000);
    expect(reported).not.toContain("working");
  });
});
