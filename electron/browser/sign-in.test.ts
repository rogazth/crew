import { describe, expect, it } from "vitest";
import { firefoxUserAgent } from "./identity";
import { passForFirefoxOnSignIn } from "./sign-in";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const FIREFOX = firefoxUserAgent("darwin");

function world(hostname: string, protocol = "https:") {
  class Navigator {
    get userAgentData() {
      return { brands: [{ brand: "Chromium", version: "152" }] };
    }
    get vendor() {
      return "Google Inc.";
    }
    get userAgent() {
      return CHROME;
    }
    get appVersion() {
      return "5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
    }
  }
  return { location: { hostname, protocol }, chrome: { runtime: {} } as unknown, Navigator, nav: new Navigator() };
}

describe("passForFirefoxOnSignIn", () => {
  it("hides what only Chrome has on Google's sign-in", () => {
    const page = world("accounts.google.com");
    expect(passForFirefoxOnSignIn(FIREFOX, page)).toBe(true);
    expect(page.nav.userAgentData).toBeUndefined();
    expect(page.nav.vendor).toBe("");
    expect(page.chrome).toBeUndefined();
  });

  it("names Firefox to the page's scripts, as its requests do", () => {
    const page = world("accounts.google.com");
    passForFirefoxOnSignIn(FIREFOX, page);
    expect(page.nav.userAgent).toBe(FIREFOX);
    expect(page.nav.appVersion).toBe("5.0 (Macintosh)");
  });

  it.each([["mail.google.com"], ["accounts.google.com.evil.com"], ["github.com"]])("leaves %s alone", (host) => {
    const page = world(host);
    expect(passForFirefoxOnSignIn(FIREFOX, page)).toBe(false);
    expect(page.nav.userAgentData).toBeDefined();
    expect(page.chrome).toBeDefined();
    expect(page.nav.userAgent).toBe(CHROME);
  });

  it("leaves plain http alone", () => {
    const page = world("accounts.google.com", "http:");
    expect(passForFirefoxOnSignIn(FIREFOX, page)).toBe(false);
    expect(page.nav.vendor).toBe("Google Inc.");
  });
});
