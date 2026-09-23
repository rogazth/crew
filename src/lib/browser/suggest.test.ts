import { describe, expect, it } from "vitest";
import { buildSuggestions } from "./suggest";
import { resolveAddress } from "./url";

const visit = (url: string, title = "") => ({ url, title });

function suggest(input: string, history: { url: string; title: string }[], limit?: number) {
  return buildSuggestions(input, resolveAddress(input), history, limit);
}

describe("buildSuggestions", () => {
  it("offers history alone, in the daemon's order, while the bar is empty", () => {
    const rows = suggest("", [visit("https://b.dev/", "B"), visit("https://a.dev/", "A")]);
    expect(rows).toEqual([
      { kind: "history", url: "https://b.dev/", label: "B", title: "B" },
      { kind: "history", url: "https://a.dev/", label: "A", title: "A" },
    ]);
  });

  it("treats a bar holding only spaces as empty", () => {
    expect(suggest("   ", [visit("https://a.dev/")]).map((row) => row.kind)).toEqual(["history"]);
  });

  it("puts going to a URL on top", () => {
    expect(suggest("example.com", [])[0]).toEqual({
      kind: "go",
      url: "https://example.com",
      label: "https://example.com",
    });
  });

  it("puts searching on top, labelled with the query", () => {
    expect(suggest("react hooks", [])[0]).toEqual({
      kind: "search",
      url: "https://www.google.com/search?q=react%20hooks",
      label: "react hooks",
    });
  });

  it("drops the history row that is the page on top", () => {
    const rows = suggest("EXAMPLE.com", [
      visit("https://example.com/#top", "Example"),
      visit("https://example.com/docs", "Docs"),
    ]);
    expect(rows.map((row) => row.url)).toEqual(["https://EXAMPLE.com", "https://example.com/docs"]);
  });

  it("keeps history rows that only share a prefix with the page on top", () => {
    const rows = suggest("https://example.com/a", [visit("https://example.com/a/b"), visit("https://example.com/A")]);
    expect(rows).toHaveLength(3);
  });

  it("drops a history row that matches a search URL", () => {
    const rows = suggest("foo", [visit("https://www.google.com/search?q=foo", "foo - Google Search")]);
    expect(rows.map((row) => row.kind)).toEqual(["search"]);
  });

  it("labels a history row with its URL when it has no title", () => {
    const rows = suggest("", [visit("https://a.dev/", ""), visit("https://b.dev/", "  ")]);
    expect(rows.map((row) => row.label)).toEqual(["https://a.dev/", "https://b.dev/"]);
  });

  it("caps at eight by default, counting the row on top", () => {
    const history = Array.from({ length: 20 }, (_, n) => visit(`https://site${n}.dev/`));
    expect(suggest("", history)).toHaveLength(8);
    expect(suggest("site", history)).toHaveLength(8);
    expect(suggest("site", history)[0]?.kind).toBe("search");
  });

  it("honours a custom limit", () => {
    const history = [visit("https://a.dev/"), visit("https://b.dev/")];
    expect(suggest("x", history, 2).map((row) => row.kind)).toEqual(["search", "history"]);
    expect(suggest("x", history, 1).map((row) => row.kind)).toEqual(["search"]);
    expect(suggest("x", history, 0)).toEqual([]);
  });
});
