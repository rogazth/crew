import { describe, expect, it } from "vitest";
import { isDerivedSessionName } from "./workspaces";

describe("isDerivedSessionName", () => {
  it("claims the names nextSessionName hands out", () => {
    expect(isDerivedSessionName("claude", "claude")).toBe(true);
    expect(isDerivedSessionName("claude 2", "claude")).toBe(true);
    expect(isDerivedSessionName("claude 17", "claude")).toBe(true);
  });

  it("leaves a name the user typed alone", () => {
    expect(isDerivedSessionName("claude notes", "claude")).toBe(false);
    expect(isDerivedSessionName("claude 2 notes", "claude")).toBe(false);
    expect(isDerivedSessionName("Refactor the tab bar", "claude")).toBe(false);
    expect(isDerivedSessionName("codex", "claude")).toBe(false);
  });
});
