import { describe, expect, it } from "vitest";
import { launcherAddress, launcherPages } from "./launch";

describe("launcherAddress", () => {
  it("opens a dev server over http and reads back what was typed", () => {
    expect(launcherAddress(" localhost:3200 ", true)).toEqual({
      url: "http://localhost:3200",
      label: "localhost:3200",
      lead: true,
    });
  });

  it("drops the scheme from the label only", () => {
    expect(launcherAddress("https://example.com/a", true)).toEqual({
      url: "https://example.com/a",
      label: "example.com/a",
      lead: true,
    });
  });

  it("offers nothing for a search, an empty query or a scheme that never navigates", () => {
    expect(launcherAddress("fix the login bug", false)).toBeNull();
    expect(launcherAddress("claude", false)).toBeNull();
    expect(launcherAddress("   ", false)).toBeNull();
    expect(launcherAddress("javascript:alert(1)", false)).toBeNull();
    expect(launcherAddress("about:blank", false)).toBeNull();
  });

  it("leads with a bare dotted name only while nothing else matches", () => {
    expect(launcherAddress("notes.md", false)?.lead).toBe(true);
    expect(launcherAddress("notes.md", true)?.lead).toBe(false);
  });

  it("leads with a port, a path or a local host even when sessions match", () => {
    expect(launcherAddress("example.com:8080", true)?.lead).toBe(true);
    expect(launcherAddress("example.com/docs", true)?.lead).toBe(true);
    expect(launcherAddress("localhost", true)?.lead).toBe(true);
    expect(launcherAddress("192.168.1.20", true)?.lead).toBe(true);
    expect(launcherAddress("app.localhost", true)?.lead).toBe(true);
  });
});

describe("launcherPages", () => {
  const page = (url: string) => ({ url, title: "" });

  it("skips the page the address row already opens", () => {
    const address = launcherAddress("localhost:3200", false);
    const pages = launcherPages(address, [page("http://localhost:3200/"), page("http://localhost:3200/admin")], 5);
    expect(pages.map((p) => p.url)).toEqual(["http://localhost:3200/admin"]);
  });

  it("keeps the daemon's order up to the limit", () => {
    const pages = launcherPages(null, [page("https://a.dev/"), page("https://b.dev/"), page("https://c.dev/")], 2);
    expect(pages.map((p) => p.url)).toEqual(["https://a.dev/", "https://b.dev/"]);
  });
});
