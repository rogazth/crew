import { describe, expect, it } from "vitest";
import { isBusy, setBusy } from "./terminalBusy";

describe("terminal busy", () => {
  it("is idle for a session nobody marked", () => {
    expect(isBusy("never-seen")).toBe(false);
  });

  it("holds a busy mark until it is cleared", () => {
    setBusy("a", true);
    expect(isBusy("a")).toBe(true);
    setBusy("a", true);
    expect(isBusy("a")).toBe(true);
    setBusy("a", false);
    expect(isBusy("a")).toBe(false);
  });

  it("tracks each session on its own", () => {
    setBusy("b", true);
    setBusy("c", true);
    setBusy("b", false);
    expect(isBusy("b")).toBe(false);
    expect(isBusy("c")).toBe(true);
    setBusy("c", false);
  });

  it("ignores clearing a session that was not busy", () => {
    setBusy("d", false);
    expect(isBusy("d")).toBe(false);
  });
});
