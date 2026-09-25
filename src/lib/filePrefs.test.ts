import { describe, expect, it } from "vitest";
import { DEFAULT_FILE_PREFS, parseFilePrefs, parseFolders } from "./filePrefs";

describe("parseFolders", () => {
  it("splits on commas and newlines, trims slashes and drops repeats", () => {
    expect(parseFolders(" .ai/, .claude\n/.ai ,, docs/private/ ")).toEqual([".ai", ".claude", "docs/private"]);
    expect(parseFolders("")).toEqual([]);
  });
});

describe("parseFilePrefs", () => {
  it("defaults when nothing was saved or it does not parse", () => {
    expect(parseFilePrefs(null)).toEqual(DEFAULT_FILE_PREFS);
    expect(parseFilePrefs("{nope")).toEqual(DEFAULT_FILE_PREFS);
    expect(parseFilePrefs(JSON.stringify({ include: ".ai" }))).toEqual(DEFAULT_FILE_PREFS);
  });

  it("keeps only string folders", () => {
    expect(parseFilePrefs(JSON.stringify({ include: [".ai", 3, null, ".claude/"] }))).toEqual({
      include: [".ai", ".claude"],
    });
  });
});
