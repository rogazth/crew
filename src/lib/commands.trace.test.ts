import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand, runCommand } from "./commands";
import { trace } from "./trace";

describe("running a command", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let now = 1_000_000;
  beforeEach(() => {
    info = vi.spyOn(trace, "info").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes ui.command with the command's id and how it was triggered, before it runs", () => {
    const order: string[] = [];
    info.mockImplementation(() => void order.push("traced"));
    const off = registerCommand("open-launcher", () => order.push("ran"));
    expect(runCommand("open-launcher", "palette")).toBe(true);
    expect(order).toEqual(["traced", "ran"]);
    runCommand("open-launcher", "keyboard");
    runCommand("open-launcher");
    expect(info.mock.calls.map((call) => call[1])).toEqual([
      { command: "open-launcher", via: "palette" },
      { command: "open-launcher", via: "keyboard" },
      { command: "open-launcher", via: "button" },
    ]);
    off();
  });

  it("writes nothing for a command no one handles", () => {
    expect(runCommand("close")).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it("writes the first of a held chord and then one a second, with how many it skipped", () => {
    const off = registerCommand("next-tab", () => {});
    for (let at = 0; at < 30; at += 1) {
      now += 30;
      runCommand("next-tab", "keyboard");
    }
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toEqual({ command: "next-tab", via: "keyboard", repeatable: true, repeats_before: undefined });
    now += 2000;
    runCommand("next-tab", "keyboard");
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1]?.[1]).toMatchObject({ repeats_before: 29 });
    off();
  });
});
