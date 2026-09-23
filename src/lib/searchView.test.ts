import { describe, expect, it } from "vitest";
import { countLabel, failureText, SEARCH_PAGE, searchQuery } from "./searchView";

const NOON = new Date(2026, 8, 23, 12, 0, 0).getTime();
const DAY = 86_400_000;

describe("searchQuery", () => {
  it("searches every agent and all time by default, asking for one more than a page", () => {
    expect(searchQuery("needle", "any", "relevance", "", NOON)).toEqual({
      query: "needle",
      sessionIds: [],
      sort: "relevance",
      limit: SEARCH_PAGE + 1,
    });
  });

  it("narrows to one agent when one is picked", () => {
    expect(searchQuery("needle", "any", "newest", "s1", NOON)).toMatchObject({ sessionIds: ["s1"], sort: "newest" });
  });

  it("starts today at local midnight and the longer ranges that many days back", () => {
    expect(searchQuery("x", "today", "relevance", "", NOON).from).toBe(new Date(2026, 8, 23).getTime());
    expect(searchQuery("x", "week", "relevance", "", NOON).from).toBe(NOON - 7 * DAY);
    expect(searchQuery("x", "month", "relevance", "", NOON).from).toBe(NOON - 30 * DAY);
  });

  it("leaves from out entirely for any time", () => {
    expect("from" in searchQuery("x", "any", "relevance", "", NOON)).toBe(false);
  });
});

describe("countLabel", () => {
  it("says one result in the singular", () => {
    expect(countLabel(1)).toBe("1 result");
  });

  it("counts zero and a full page exactly", () => {
    expect(countLabel(0)).toBe("0 results");
    expect(countLabel(SEARCH_PAGE)).toBe("100 results");
  });

  it("never claims more than the page it reached", () => {
    expect(countLabel(SEARCH_PAGE + 1)).toBe("100+ results");
  });
});

describe("failureText", () => {
  it("shows an error's message and stringifies anything else", () => {
    expect(failureText(new Error("index is locked"))).toBe("index is locked");
    expect(failureText("daemon gone")).toBe("daemon gone");
  });
});
