import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_PREFS, parseBrowserPrefs, SEARCH_ENGINES } from "./browserPrefs";

describe("parseBrowserPrefs", () => {
  it("defaults when nothing was saved or it does not parse", () => {
    expect(parseBrowserPrefs(null)).toEqual(DEFAULT_BROWSER_PREFS);
    expect(parseBrowserPrefs("{nope")).toEqual(DEFAULT_BROWSER_PREFS);
    expect(parseBrowserPrefs("3")).toEqual(DEFAULT_BROWSER_PREFS);
  });

  it("keeps known values", () => {
    const template = SEARCH_ENGINES[1].template;
    expect(parseBrowserPrefs(JSON.stringify({ searchTemplate: template, keep: 10 }))).toEqual({
      searchTemplate: template,
      keep: 10,
    });
  });

  it("falls back field by field, and never takes a template it does not know", () => {
    const raw = JSON.stringify({ searchTemplate: "javascript:alert(%s)", keep: 4 });
    expect(parseBrowserPrefs(raw)).toEqual({ searchTemplate: DEFAULT_BROWSER_PREFS.searchTemplate, keep: 4 });
    expect(parseBrowserPrefs(JSON.stringify({ keep: 1000 })).keep).toBe(DEFAULT_BROWSER_PREFS.keep);
  });
});
