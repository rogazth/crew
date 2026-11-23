import { describe, expect, it } from "vitest";
import { barText, buildSuggestions, chosenRow, inlineCompletion, stepHighlight } from "./suggest";
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

describe("inlineCompletion", () => {
  const visits = (...urls: string[]) => urls.map((url) => ({ url }));

  it("completes a host as typed, keeping the person's letters", () => {
    expect(inlineCompletion("GitH", visits("https://github.com/crew/app"))).toEqual({ suffix: "ub.com", url: "https://github.com/" });
  });

  it("skips www. and the scheme, or completes them when typed", () => {
    const history = visits("https://www.example.com/a");
    expect(inlineCompletion("exa", history)).toEqual({ suffix: "mple.com", url: "https://www.example.com/" });
    expect(inlineCompletion("www.ex", history)).toEqual({ suffix: "ample.com", url: "https://www.example.com/" });
    expect(inlineCompletion("https://ex", history)).toEqual({ suffix: "ample.com", url: "https://www.example.com/" });
    expect(inlineCompletion("http://ex", history)).toBeNull();
  });

  it("keeps the port and the visit's own scheme", () => {
    expect(inlineCompletion("localhost:3", visits("http://localhost:3000/app"))).toEqual({
      suffix: "000",
      url: "http://localhost:3000/",
    });
    expect(inlineCompletion("intra", visits("http://intranet.corp/"))).toEqual({ suffix: "net.corp", url: "http://intranet.corp/" });
  });

  it("completes the page once the text goes past the host", () => {
    expect(inlineCompletion("github.com/cr", visits("https://github.com/crew/app#readme"))).toEqual({
      suffix: "ew/app",
      url: "https://github.com/crew/app",
    });
  });

  it("leaves a whole host alone, even when a longer one starts the same", () => {
    expect(inlineCompletion("github.com", visits("https://github.community/", "https://github.com/x"))).toBeNull();
  });

  it("follows the daemon's order", () => {
    expect(inlineCompletion("g", visits("https://gmail.com/", "https://github.com/"))?.url).toBe("https://gmail.com/");
  });

  it("matches an international host in its own letters", () => {
    expect(inlineCompletion("büc", visits("https://xn--bcher-kva.de/"))).toEqual({ suffix: "her.de", url: "https://xn--bcher-kva.de/" });
  });

  it("completes nothing for spaces, searches or other schemes", () => {
    expect(inlineCompletion("", visits("https://a.dev/"))).toBeNull();
    expect(inlineCompletion("a b", visits("https://a.dev/"))).toBeNull();
    expect(inlineCompletion("fi", visits("file:///tmp/file.html"))).toBeNull();
  });

  it("puts the completed address on top of the list", () => {
    const rows = buildSuggestions("git", resolveAddress("git"), [visit("https://github.com/", "GitHub")], 8, "https://github.com/");
    expect(rows).toEqual([{ kind: "go", url: "https://github.com/", label: "https://github.com/" }]);
  });
});

describe("the lit row", () => {
  const rows = buildSuggestions("exa", resolveAddress("exa"), [visit("https://example.com/a", "A"), visit("https://example.org/", "B")]);

  it("leaves the bar and Enter alone when the pointer lit it", () => {
    const hover = { at: 1, by: "pointer" as const };
    expect(barText("exa", rows, hover)).toBe("exa");
    expect(chosenRow(rows, hover)).toBeNull();
  });

  it("shows and opens the row the arrows chose", () => {
    const keys = { at: 1, by: "keys" as const };
    expect(barText("exa", rows, keys)).toBe("https://example.com/a");
    expect(chosenRow(rows, keys)?.url).toBe("https://example.com/a");
  });

  it("reads a search row back as its words", () => {
    expect(barText("exa", rows, { at: 0, by: "keys" })).toBe("exa");
  });

  it("walks from the pointer's row and back up to what was typed", () => {
    expect(stepHighlight({ at: 1, by: "pointer" }, 1, rows.length)).toEqual({ at: 2, by: "keys" });
    expect(stepHighlight(null, 1, rows.length)).toEqual({ at: 0, by: "keys" });
    expect(stepHighlight({ at: 0, by: "keys" }, -1, rows.length)).toBeNull();
    expect(stepHighlight({ at: 2, by: "keys" }, 1, rows.length)).toEqual({ at: 2, by: "keys" });
  });
});
