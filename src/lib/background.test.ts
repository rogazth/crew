import { describe, expect, it } from "vitest";
import {
  markedCalls,
  plainText,
  stateLabel,
  turnTray,
} from "./background";
import type { BackgroundCommand, BackgroundList } from "./protocol";

const NOW = 1_000_000;

function command(id: string, extra: Partial<BackgroundCommand> = {}): BackgroundCommand {
  return { id, command: `sleep ${id}`, kind: "shell", startedAt: NOW - 125_000, state: "running", ...extra };
}

function list(commands: BackgroundCommand[], extra: Partial<BackgroundList> = {}): BackgroundList {
  return { sessionId: "s1", commands, live: true, waiting: false, hidden: [], ...extra };
}

describe("the tray", () => {
  it("lists a driven turn's commands, the daemon having cleared the last turn's", () => {
    expect(turnTray(null)).toEqual([]);
    expect(turnTray(list([command("a")]))).toHaveLength(1);
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
