import { describe, expect, it } from "vitest";
import {
  browserTitle,
  newBrowserTab,
  openTab,
  parseTabs,
  patchBrowserTab,
  tabTitle,
  type TabState,
} from "./tabs";
import type { Tab } from "./types";

const file = (name: string): Tab => ({ id: `file:${name}`, kind: "file", path: `/w/${name}`, relative: name });

function state(tabs: Tab[], activeId: string | null = tabs[0]?.id ?? null): TabState {
  return { tabs, activeId, closed: [] };
}

describe("newBrowserTab", () => {
  it("mints a fresh id every time, so two tabs can show one URL", () => {
    const a = newBrowserTab("https://example.com");
    const b = newBrowserTab("https://example.com");
    expect(a.id).toMatch(/^browser:[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ kind: "browser", url: "https://example.com", title: "" });
  });
});

describe("openTab placement", () => {
  const a = file("a");
  const b = file("b");
  const c = file("c");

  it("appends and focuses by default", () => {
    const next = openTab(state([a, b]), c);
    expect(next.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(next.activeId).toBe(c.id);
  });

  it("lands beside the tab that asked for it", () => {
    const next = openTab(state([a, b]), c, { after: a.id });
    expect(next.tabs.map((t) => t.id)).toEqual([a.id, c.id, b.id]);
  });

  it("falls back to the end when the anchor is gone", () => {
    const next = openTab(state([a, b]), c, { after: "file:gone" });
    expect(next.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
  });

  it("leaves the active tab alone in the background", () => {
    const next = openTab(state([a, b], a.id), c, { background: true });
    expect(next.activeId).toBe(a.id);
    expect(next.tabs).toHaveLength(3);
  });

  it("focuses an already-open tab even when asked for the background", () => {
    const next = openTab(state([a, b], a.id), b, { background: true });
    expect(next.activeId).toBe(b.id);
  });

  it("returns the same state when nothing changes", () => {
    const s = state([a, b], b.id);
    expect(openTab(s, b)).toBe(s);
  });
});

describe("patchBrowserTab", () => {
  const page = { ...newBrowserTab("https://a.com"), title: "A" } as Tab;

  it("updates url and title", () => {
    const next = patchBrowserTab(state([page]), page.id, { url: "https://b.com", title: "B" });
    expect(next.tabs[0]).toMatchObject({ url: "https://b.com", title: "B" });
  });

  it("returns the same state when nothing moved", () => {
    const s = state([page]);
    expect(patchBrowserTab(s, page.id, { url: "https://a.com", title: "A" })).toBe(s);
    expect(patchBrowserTab(s, page.id, {})).toBe(s);
  });

  it("never touches a tab of another kind", () => {
    const a = file("a");
    const s = state([a]);
    expect(patchBrowserTab(s, a.id, { title: "x" })).toBe(s);
  });
});

describe("parseTabs with pages", () => {
  it("restores browser tabs", () => {
    const page = { id: "browser:1", kind: "browser", url: "https://a.com", title: "A" };
    const restored = parseTabs(JSON.stringify({ tabs: [page], activeId: "browser:1" }));
    expect(restored.tabs).toEqual([page]);
    expect(restored.activeId).toBe("browser:1");
  });

  it("drops browser tabs with a broken shape", () => {
    const raw = JSON.stringify({
      tabs: [
        { id: "browser:1", kind: "browser", url: 3, title: "" },
        { id: "browser:2", kind: "browser", url: "" },
        { id: "nope", kind: "browser", url: "", title: "" },
      ],
      activeId: "browser:1",
    });
    expect(parseTabs(raw).tabs).toEqual([]);
  });

  it("turns the old placeholder stub into a blank page and keeps it active", () => {
    const raw = JSON.stringify({
      tabs: [file("a"), { id: "stub:browser", kind: "stub", stub: "browser", title: "Browser" }],
      activeId: "stub:browser",
    });
    const restored = parseTabs(raw);
    const page = restored.tabs[1];
    expect(page).toMatchObject({ kind: "browser", url: "", title: "" });
    expect(page?.id).toMatch(/^browser:/);
    expect(restored.activeId).toBe(page?.id);
  });
});

describe("browserTitle", () => {
  it("prefers the page title, then the host, then New Tab", () => {
    expect(browserTitle("Docs", "https://a.com/x")).toBe("Docs");
    expect(browserTitle("  ", "https://a.com:8080/x")).toBe("a.com:8080");
    expect(browserTitle("", "")).toBe("New Tab");
    expect(browserTitle("", "about:blank")).toBe("New Tab");
    expect(browserTitle("", "not a url")).toBe("New Tab");
  });

  it("is what tabTitle shows for a page", () => {
    const tab: Tab = { id: "browser:1", kind: "browser", url: "http://localhost:3000/", title: "" };
    expect(tabTitle(tab, [])).toBe("localhost:3000");
  });
});
