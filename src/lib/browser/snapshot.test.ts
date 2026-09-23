import { describe, expect, it } from "vitest";
import { capSnapshot, parseSnapshot, type NavEntry } from "./snapshot";

const page = (n: number, pageState?: string): NavEntry =>
  pageState === undefined
    ? { url: `https://example.com/${n}`, title: `Page ${n}` }
    : { url: `https://example.com/${n}`, title: `Page ${n}`, pageState };

const pages = (count: number): NavEntry[] => Array.from({ length: count }, (_, n) => page(n));

const bytes = (entries: NavEntry[]) => new TextEncoder().encode(JSON.stringify(entries)).length;

const titles = (entries: NavEntry[] | undefined) => entries?.map((e) => e.title);

describe("capSnapshot", () => {
  it("keeps a stack that already fits", () => {
    const entries = [page(0), page(1, "state"), page(2)];
    expect(capSnapshot({ entries, index: 1 })).toEqual({ entries, index: 1 });
  });

  it("leaves the input untouched", () => {
    const entries = [{ url: "about:blank", title: "" }, page(1, "x".repeat(100)), page(2, "y".repeat(100))];
    const before = structuredClone(entries);
    capSnapshot({ entries, index: 1 }, { maxBytes: 150 });
    expect(entries).toEqual(before);
  });

  it("drops what is not a web page and moves the index with it", () => {
    const entries: NavEntry[] = [
      { url: "about:blank", title: "" },
      page(1),
      { url: "file:///etc/passwd", title: "passwd" },
      page(3),
      { url: "not a url", title: "junk" },
      { url: "HTTP://EXAMPLE.COM/5", title: "Page 5" },
    ];
    expect(capSnapshot({ entries, index: 3 })).toEqual({
      entries: [page(1), page(3), { url: "HTTP://EXAMPLE.COM/5", title: "Page 5" }],
      index: 1,
    });
  });

  it("gives up when the active entry is not a web page", () => {
    const blank = { url: "about:blank", title: "" };
    expect(capSnapshot({ entries: [blank], index: 0 })).toBeNull();
    expect(capSnapshot({ entries: [page(0), blank], index: 1 })).toBeNull();
    expect(capSnapshot({ entries: [page(0), { url: "javascript:alert(1)", title: "" }], index: 1 })).toBeNull();
  });

  it("gives up on an empty stack or an index that points nowhere", () => {
    expect(capSnapshot({ entries: [], index: 0 })).toBeNull();
    expect(capSnapshot({ entries: pages(3), index: -1 })).toBeNull();
    expect(capSnapshot({ entries: pages(3), index: 3 })).toBeNull();
    expect(capSnapshot({ entries: pages(3), index: 1.5 })).toBeNull();
    expect(capSnapshot({ entries: pages(3), index: Number.NaN })).toBeNull();
  });

  it("keeps 50 entries around the index by default, the odd one behind it", () => {
    const result = capSnapshot({ entries: pages(201), index: 100 });
    expect(result?.entries).toHaveLength(50);
    expect(result?.index).toBe(25);
    expect(result?.entries[0]?.title).toBe("Page 75");
    expect(result?.entries[result.index]?.title).toBe("Page 100");
    expect(result?.entries.at(-1)?.title).toBe("Page 124");
  });

  it("gives the back side whatever the forward side cannot use", () => {
    const result = capSnapshot({ entries: pages(104), index: 100 }, { maxEntries: 10 });
    expect(titles(result?.entries)).toEqual(
      [94, 95, 96, 97, 98, 99, 100, 101, 102, 103].map((n) => `Page ${n}`),
    );
    expect(result?.index).toBe(6);
  });

  it("gives the forward side whatever the back side cannot use", () => {
    const result = capSnapshot({ entries: pages(100), index: 2 }, { maxEntries: 10 });
    expect(titles(result?.entries)).toEqual(Array.from({ length: 10 }, (_, n) => `Page ${n}`));
    expect(result?.index).toBe(2);
  });

  it("counts the window after dropping what is not a web page", () => {
    const entries = [page(0), { url: "about:blank", title: "" }, page(2), page(3)];
    expect(capSnapshot({ entries, index: 3 }, { maxEntries: 3 })).toEqual({
      entries: [page(0), page(2), page(3)],
      index: 2,
    });
  });

  it("strips pageState oldest first, the active entry's last, until it fits", () => {
    const state = "s".repeat(1000);
    const entries = [page(0, state), page(1, state), page(2, state), page(3, state)];
    const twoStripped = [page(0), page(1, state), page(2), page(3, state)];
    expect(capSnapshot({ entries, index: 1 }, { maxBytes: bytes(twoStripped) })).toEqual({
      entries: twoStripped,
      index: 1,
    });

    const othersStripped = [page(0), page(1, state), page(2), page(3)];
    expect(capSnapshot({ entries, index: 1 }, { maxBytes: bytes(othersStripped) })).toEqual({
      entries: othersStripped,
      index: 1,
    });

    const allStripped = pages(4);
    expect(capSnapshot({ entries, index: 1 }, { maxBytes: bytes(othersStripped) - 1 })).toEqual({
      entries: allStripped,
      index: 1,
    });
  });

  it("then drops entries farthest from the index, forward first on a tie", () => {
    const state = "s".repeat(1000);
    const entries = [page(0, state), page(1), page(2, state), page(3), page(4)];
    const fit = (count: number, from: number) => ({
      maxBytes: bytes(pages(5).slice(from, from + count)),
    });
    // Distances 2 1 0 1 2: the forward 2 goes, then the back 2, then the forward 1.
    expect(titles(capSnapshot({ entries, index: 2 }, fit(4, 0))?.entries)).toEqual([
      "Page 0",
      "Page 1",
      "Page 2",
      "Page 3",
    ]);
    expect(capSnapshot({ entries, index: 2 }, fit(3, 1))).toEqual({ entries: [page(1), page(2), page(3)], index: 1 });
    expect(capSnapshot({ entries, index: 2 }, fit(2, 1))).toEqual({ entries: [page(1), page(2)], index: 1 });
    expect(capSnapshot({ entries, index: 2 }, fit(1, 2))).toEqual({ entries: [page(2)], index: 0 });
  });

  it("measures UTF-8 bytes, not characters", () => {
    const wide = (n: number): NavEntry => ({ url: `https://example.com/${n}`, title: "日本語".repeat(100) });
    const entries = [wide(0), wide(1), wide(2)];
    const two = [wide(1), wide(2)];
    // As characters all three would fit.
    const maxBytes = bytes(two);
    expect(JSON.stringify(entries).length).toBeLessThan(maxBytes);
    const result = capSnapshot({ entries, index: 2 }, { maxBytes });
    expect(result).toEqual({ entries: two, index: 1 });
    expect(bytes(result?.entries ?? [])).toBeLessThanOrEqual(maxBytes);
  });

  it("gives up when the active entry alone is over budget", () => {
    const huge: NavEntry = { url: `https://example.com/?q=${"x".repeat(300_000)}`, title: "" };
    expect(capSnapshot({ entries: [page(0), huge], index: 1 })).toBeNull();
  });

  it("keeps a large stack under 256 KiB by default", () => {
    const entries = Array.from({ length: 50 }, (_, n) => page(n, "s".repeat(20_000)));
    const result = capSnapshot({ entries, index: 49 });
    expect(result).not.toBeNull();
    expect(bytes(result?.entries ?? [])).toBeLessThanOrEqual(256 * 1024);
    expect(result?.entries).toHaveLength(50);
    expect(result?.entries[49]?.pageState).toHaveLength(20_000);
    expect(result?.entries[0]?.pageState).toBeUndefined();
  });
});

describe("parseSnapshot", () => {
  it("reads back what was stored", () => {
    const entries = [page(0), page(1, "state"), { url: "about:blank", title: "" }];
    expect(parseSnapshot(JSON.stringify(entries), 1)).toEqual({ entries, index: 1 });
  });

  it("drops fields restore() does not read", () => {
    const json = JSON.stringify([{ url: "https://a.test/", title: "A", extra: { deep: true } }]);
    expect(parseSnapshot(json, 0)).toEqual({ entries: [{ url: "https://a.test/", title: "A" }], index: 0 });
  });

  it.each([
    ["not JSON", "{"],
    ["an object", JSON.stringify({ entries: [page(0)] })],
    ["a string", JSON.stringify("https://a.test/")],
    ["null", "null"],
    ["an empty stack", "[]"],
    ["a null entry", JSON.stringify([page(0), null])],
    ["a string entry", JSON.stringify(["https://a.test/"])],
    ["an array entry", JSON.stringify([["https://a.test/", "A"]])],
    ["a missing url", JSON.stringify([{ title: "A" }])],
    ["a numeric url", JSON.stringify([{ url: 1, title: "A" }])],
    ["a missing title", JSON.stringify([{ url: "https://a.test/" }])],
    ["a numeric pageState", JSON.stringify([{ url: "https://a.test/", title: "A", pageState: 1 }])],
    ["a null pageState", JSON.stringify([{ url: "https://a.test/", title: "A", pageState: null }])],
  ])("rejects %s", (_, json) => {
    expect(parseSnapshot(json, 0)).toBeNull();
  });

  it("rejects an index that points nowhere", () => {
    const json = JSON.stringify(pages(3));
    expect(parseSnapshot(json, 3)).toBeNull();
    expect(parseSnapshot(json, -1)).toBeNull();
    expect(parseSnapshot(json, 0.5)).toBeNull();
    expect(parseSnapshot(json, Number.NaN)).toBeNull();
  });
});
