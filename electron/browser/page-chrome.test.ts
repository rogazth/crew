import { describe, expect, it } from "vitest";
import { passForChrome } from "./page-chrome";

const BRANDS = [
  { brand: "Not?A_Brand", version: "24" },
  { brand: "Chromium", version: "152" },
];

function world(hostname: string, protocol = "https:") {
  class NavigatorUAData {
    get brands() {
      return Object.freeze(BRANDS.map((b) => ({ ...b })));
    }
    getHighEntropyValues(_hints: string[]) {
      return Promise.resolve({
        brands: BRANDS.map((b) => ({ ...b })),
        fullVersionList: [
          { brand: "Not?A_Brand", version: "24.0.0.0" },
          { brand: "Chromium", version: "152.0.7977.76" },
        ],
        platform: "macOS",
      });
    }
    toJSON() {
      return { brands: this.brands, mobile: false, platform: "macOS" };
    }
  }
  function Fn() {}
  const functionProto = { toString: () => "source" };
  Fn.prototype = functionProto;
  return {
    location: { hostname, protocol },
    chrome: {} as Record<string, unknown>,
    Function: Fn as unknown as { prototype: { toString: () => string } },
    NavigatorUAData,
    ua: new NavigatorUAData(),
    performance: {
      timing: { navigationStart: 1000, responseStart: 1100, domContentLoadedEventEnd: 1500, loadEventEnd: 1600 },
      now: () => 700,
      getEntriesByType: (type: string) =>
        type === "navigation" ? [{ startTime: 0, nextHopProtocol: "h2" }] : [{ name: "first-paint", startTime: 300 }],
    },
  };
}

describe("passForChrome", () => {
  it("adds Google Chrome after Chromium, the way the header has it", async () => {
    const page = world("example.com");
    expect(passForChrome(page)).toBe(true);
    const brands = page.ua.brands;
    expect(brands).toEqual([...BRANDS, { brand: "Google Chrome", version: "152" }]);
    expect(Object.isFrozen(brands)).toBe(true);
    expect(page.ua.brands).toBe(brands);
    const values = await page.ua.getHighEntropyValues(["fullVersionList"]);
    expect(values.fullVersionList.at(-1)).toEqual({ brand: "Google Chrome", version: "152.0.7977.76" });
    expect(values.brands.at(-1)).toEqual({ brand: "Google Chrome", version: "152" });
    expect(page.ua.toJSON().brands).toHaveLength(3);
  });

  it("gives window.chrome what Chrome's has", () => {
    const page = world("example.com");
    passForChrome(page);
    expect(Object.keys(page.chrome)).toEqual(["loadTimes", "csi", "app"]);
    const loadTimes = (page.chrome.loadTimes as () => Record<string, unknown>)();
    expect(loadTimes).toMatchObject({ requestTime: 1, firstPaintTime: 1.3, npnNegotiatedProtocol: "h2", wasFetchedViaSpdy: true });
    expect((page.chrome.csi as () => unknown)()).toEqual({ startE: 1000, onloadT: 1500, pageT: 700, tran: 15 });
    expect((page.chrome.app as { isInstalled: boolean }).isInstalled).toBe(false);
  });

  it("shows native source for what it replaced", () => {
    const page = world("example.com");
    passForChrome(page);
    const show = page.Function.prototype.toString;
    expect(show.call(page.chrome.csi)).toBe("function csi() { [native code] }");
    expect(show.call(page.NavigatorUAData.prototype.getHighEntropyValues)).toBe("function getHighEntropyValues() { [native code] }");
    expect(show.call(show)).toBe("function toString() { [native code] }");
    expect(show.call(() => 1)).toBe("source");
  });

  it("leaves Google's sign-in to look like Firefox", () => {
    const page = world("accounts.google.com");
    expect(passForChrome(page)).toBe(false);
    expect(page.ua.brands).toHaveLength(2);
    expect(page.chrome).toEqual({});
  });

  it("adds nothing twice", () => {
    const page = world("example.com");
    passForChrome(page);
    passForChrome(page);
    expect(page.ua.brands.filter((b) => b.brand === "Google Chrome")).toHaveLength(1);
  });
});
