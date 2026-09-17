import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";

/** Which of a list the matcher would put first. */
function best(query: string, candidates: string[]): string | undefined {
  return candidates
    .map((text) => ({ text, hit: fuzzyMatch(query, text) }))
    .filter((row) => row.hit !== null)
    .sort((a, b) => b.hit!.score - a.hit!.score)[0]?.text;
}

describe("fuzzyMatch", () => {
  it("matches characters in order, not as a substring", () => {
    expect(fuzzyMatch("sbp", "src/lib/sidebarPrefs.ts")).not.toBeNull();
    expect(fuzzyMatch("psb", "src/lib/sidebarPrefs.ts")).toBeNull();
  });

  it("marks where it matched", () => {
    const hit = fuzzyMatch("ab", "cab");
    expect(hit?.positions).toEqual([1, 2]);
  });

  it("ignores case on both sides", () => {
    expect(fuzzyMatch("SIDEBAR", "sidebarPrefs.ts")).not.toBeNull();
    expect(fuzzyMatch("prefs", "sidebarPREFS.ts")).not.toBeNull();
  });

  it("answers for an empty query instead of refusing", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("needs every word of a multi-word query", () => {
    expect(fuzzyMatch("side prefs", "src/lib/sidebarPrefs.ts")).not.toBeNull();
    expect(fuzzyMatch("side missing", "src/lib/sidebarPrefs.ts")).toBeNull();
  });

  it("returns the positions of a multi-word match in order", () => {
    const hit = fuzzyMatch("a c", "abc");
    expect(hit?.positions).toEqual([0, 2]);
  });

  it("prefers the file whose name starts with the query", () => {
    expect(best("tabs", ["src/lib/terminalTabs.ts", "src/lib/tabs.ts"])).toBe("src/lib/tabs.ts");
  });

  it("prefers a run of consecutive characters over a scattered one", () => {
    // No separators on either side, so this is the run bonus alone.
    expect(best("abc", ["xaxbxcx", "xabcx"])).toBe("xabcx");
  });

  it("prefers a match on segment starts, which is what a path query means", () => {
    expect(best("slt", ["src/lib/tabs.ts", "specialty.ts"])).toBe("src/lib/tabs.ts");
  });

  it("rewards a camelCase boundary", () => {
    expect(best("sp", ["sidebarPrefs", "spare"])).toBe("spare");
    expect(fuzzyMatch("sp", "sidebarPrefs")).not.toBeNull();
  });

  it("prefers the shorter of two equally good matches", () => {
    expect(best("tab", ["tab.ts", "tab-with-a-long-tail.ts"])).toBe("tab.ts");
  });

  it("refuses when a character is missing", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
  });
});
