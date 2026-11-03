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
    expect(
      parseBrowserPrefs(
        JSON.stringify({
          searchTemplate: template,
          openLinksInCrew: true,
          devtoolsDock: "left",
          devtoolsWidth: 600,
          devtoolsHeight: 250,
        }),
      ),
    ).toEqual({
      searchTemplate: template,
      openLinksInCrew: true,
      devtoolsDock: "left",
      devtoolsWidth: 600,
      devtoolsHeight: 250,
    });
  });

  it("falls back field by field, and never takes a template it does not know", () => {
    const raw = JSON.stringify({ searchTemplate: "javascript:alert(%s)", openLinksInCrew: true });
    expect(parseBrowserPrefs(raw)).toEqual({ ...DEFAULT_BROWSER_PREFS, openLinksInCrew: true });
    // The background pages setting is gone; a saved one is ignored.
    expect(parseBrowserPrefs(JSON.stringify({ keep: 10 }))).toEqual(DEFAULT_BROWSER_PREFS);
    expect(parseBrowserPrefs(JSON.stringify({ openLinksInCrew: "yes" })).openLinksInCrew).toBe(false);
    expect(parseBrowserPrefs(JSON.stringify({ devtoolsDock: "top" })).devtoolsDock).toBe("bottom");
  });

  it("keeps DevTools no smaller than their minimum", () => {
    const raw = JSON.stringify({ devtoolsWidth: 12, devtoolsHeight: -1 });
    expect(parseBrowserPrefs(raw)).toMatchObject({
      devtoolsWidth: DEFAULT_BROWSER_PREFS.devtoolsWidth,
      devtoolsHeight: DEFAULT_BROWSER_PREFS.devtoolsHeight,
    });
    expect(parseBrowserPrefs(JSON.stringify({ devtoolsWidth: 512.6 })).devtoolsWidth).toBe(513);
  });
});
