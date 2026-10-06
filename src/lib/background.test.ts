import { describe, expect, it } from "vitest";
import {
  markedCalls,
  plainText,
  stateLabel,
  tabBackgroundCount,
  tabCount,
  terminalCount,
  terminalTray,
  traySummary,
  turnTray,
} from "./background";
import type { BackgroundCommand, BackgroundList, SessionLive } from "./protocol";

const NOW = 1_000_000;

function command(id: string, extra: Partial<BackgroundCommand> = {}): BackgroundCommand {
  return { id, command: `sleep ${id}`, kind: "shell", startedAt: NOW - 125_000, state: "running", ...extra };
}

function list(commands: BackgroundCommand[], extra: Partial<BackgroundList> = {}): BackgroundList {
  return { sessionId: "s1", commands, live: true, waiting: false, ...extra };
}

function live(extra: Partial<SessionLive> = {}): SessionLive {
  return { sessionId: "t1", started: true, working: false, background: true, backgroundTasks: [], updatedAt: 1, ...extra };
}

describe("the tray", () => {
  it("says what runs and what finished on its folded line", () => {
    expect(traySummary([command("a"), command("b")])).toBe("2 running");
    expect(traySummary([command("a"), command("b", { state: "completed", exitCode: 0 })])).toBe("1 running · 1 finished");
    expect(traySummary([command("a", { state: "stopped" })])).toBe("nothing running · 1 finished");
  });

  it("lists a driven turn's commands, the daemon having cleared the last turn's", () => {
    expect(turnTray(null)).toEqual([]);
    expect(turnTray(list([command("a")]))).toHaveLength(1);
  });

  it("shows a terminal's commands only once its turn is over, and hides them when the next starts", () => {
    const tasks = [command("a")];
    expect(terminalTray(live({ backgroundTasks: tasks }))).toEqual(tasks);
    expect(terminalTray(live({ backgroundTasks: tasks, working: true }))).toEqual([]);
    expect(terminalTray(null)).toEqual([]);
    // A crewd from before the tray sends no list.
    expect(terminalTray({ ...live(), backgroundTasks: undefined as unknown as BackgroundCommand[] })).toEqual([]);
  });

  it("says each command's state the way its row reads", () => {
    expect(stateLabel(command("a"), NOW)).toMatch(/^running 2m/);
    expect(stateLabel(command("a", { state: "completed", exitCode: 0 }), NOW)).toBe("exited 0");
    expect(stateLabel(command("a", { state: "failed", exitCode: 2 }), NOW)).toBe("exited 2");
    expect(stateLabel(command("a", { state: "failed" }), NOW)).toBe("failed");
    expect(stateLabel(command("a", { state: "completed" }), NOW)).toBe("finished");
    expect(stateLabel(command("a", { state: "stopped", exitCode: 143 }), NOW)).toBe("stopped");
  });

  it("marks the calls that started a command, and only those", () => {
    const calls = markedCalls([command("a", { toolCallId: "toolu_a" }), command("b")]);
    expect([...calls.keys()]).toEqual(["toolu_a"]);
    expect(calls.get("toolu_a")?.id).toBe("a");
  });

  it("reads output as plain text", () => {
    expect(plainText("\x1b[32mok\x1b[0m\r\n")).toBe("ok\n");
    expect(plainText("10%\r50%\r100%\ndone")).toBe("100%\ndone");
    expect(plainText("\x1b]0;title\x07hi")).toBe("hi");
  });
});

describe("the tab's count", () => {
  it("counts only once the turn is over, or answered and waiting on them", () => {
    const running = list([command("a"), command("b", { state: "completed" }), command("c")]);
    expect(tabCount(running, true)).toBe(0);
    expect(tabCount(running, false)).toBe(2);
    expect(tabCount({ ...running, waiting: true }, true)).toBe(2);
    expect(tabCount(null, false)).toBe(0);
    expect(tabCount(list([command("a", { state: "stopped" })]), false)).toBe(0);
  });

  it("reads a terminal's from its hooks and a driven session's from its list", () => {
    expect(terminalCount(live({ backgroundTasks: [command("a")] }))).toBe(1);
    expect(terminalCount(live({ backgroundTasks: [command("a")], working: true }))).toBe(0);
    const tasks = live({ backgroundTasks: [command("a"), command("b")] });
    expect(tabBackgroundCount({ kind: "terminal", status: "idle" }, null, tasks)).toBe(2);
    expect(tabBackgroundCount({ kind: "child", status: "working" }, list([command("a")], { waiting: true }), null)).toBe(1);
    expect(tabBackgroundCount({ kind: "bot", status: "working" }, list([command("a")]), null)).toBe(0);
    expect(tabBackgroundCount({ kind: "bot", status: "done" }, list([command("a")]), tasks)).toBe(1);
  });
});
