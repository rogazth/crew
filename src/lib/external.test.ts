import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn(() => Promise.resolve());
vi.mock("./host", () => ({ openUrl }));
vi.mock("./hotkey", () => ({ IS_MAC: true }));

const { openLink, routeLinks } = await import("./external");

const click = (mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods,
});

describe("openLink", () => {
  afterEach(() => {
    routeLinks(null);
    openUrl.mockClear();
  });

  it("opens web links in Crew while routed", () => {
    const inCrew = vi.fn();
    routeLinks(inCrew);
    openLink("https://example.com", click());
    expect(inCrew).toHaveBeenCalledWith("https://example.com");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("sends a ⌘⇧-click to the default browser while routed", () => {
    const inCrew = vi.fn();
    routeLinks(inCrew);
    openLink("https://example.com", click({ metaKey: true, shiftKey: true }));
    expect(inCrew).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("keeps ⌘-click and ⇧-click alone in Crew", () => {
    const inCrew = vi.fn();
    routeLinks(inCrew);
    openLink("https://example.com", click({ metaKey: true }));
    openLink("https://example.com", click({ shiftKey: true }));
    expect(inCrew).toHaveBeenCalledTimes(2);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("uses the default browser when not routed", () => {
    openLink("https://example.com");
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });
});
