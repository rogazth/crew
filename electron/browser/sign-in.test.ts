import { describe, expect, it } from "vitest";
import { passForFirefoxOnSignIn } from "./sign-in";

function world(hostname: string, protocol = "https:") {
  class Navigator {
    get userAgentData() {
      return { brands: [{ brand: "Chromium", version: "152" }] };
    }
    get vendor() {
      return "Google Inc.";
    }
  }
  return { location: { hostname, protocol }, chrome: { runtime: {} } as unknown, Navigator, nav: new Navigator() };
}

describe("passForFirefoxOnSignIn", () => {
  it("hides what only Chrome has on Google's sign-in", () => {
    const page = world("accounts.google.com");
    expect(passForFirefoxOnSignIn(page)).toBe(true);
    expect(page.nav.userAgentData).toBeUndefined();
    expect(page.nav.vendor).toBe("");
    expect(page.chrome).toBeUndefined();
  });

  it.each([["mail.google.com"], ["accounts.google.com.evil.com"], ["github.com"]])("leaves %s alone", (host) => {
    const page = world(host);
    expect(passForFirefoxOnSignIn(page)).toBe(false);
    expect(page.nav.userAgentData).toBeDefined();
    expect(page.chrome).toBeDefined();
  });

  it("leaves plain http alone", () => {
    const page = world("accounts.google.com", "http:");
    expect(passForFirefoxOnSignIn(page)).toBe(false);
    expect(page.nav.vendor).toBe("Google Inc.");
  });
});
