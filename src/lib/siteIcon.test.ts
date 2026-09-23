import { describe, expect, it } from "vitest";
import { faviconUrl, isPlaceholderFavicon, siteDomain, siteHost } from "./siteIcon";

describe("siteHost", () => {
  it("drops www. and lowercases", () => {
    expect(siteHost("https://WWW.GitHub.com/a/b")).toBe("github.com");
    expect(siteHost("http://docs.rs/x")).toBe("docs.rs");
  });

  it("is empty for what does not parse", () => {
    expect(siteHost("not a url")).toBe("");
  });
});

describe("siteDomain", () => {
  const domains = ["github.com", "github.io", "x.com"];

  it("matches the domain and its subdomains", () => {
    expect(siteDomain("github.com", domains)).toBe("github.com");
    expect(siteDomain("gist.github.com", domains)).toBe("github.com");
    expect(siteDomain("me.github.io", domains)).toBe("github.io");
  });

  it("does not match a host that merely ends in the same letters", () => {
    expect(siteDomain("notgithub.com", domains)).toBeNull();
    expect(siteDomain("box.com", domains)).toBeNull();
    expect(siteDomain("", domains)).toBeNull();
  });
});

describe("faviconUrl", () => {
  it("asks the resolver for the encoded host", () => {
    expect(faviconUrl("a b.com")).toBe("https://www.google.com/s2/favicons?domain=a%20b.com&sz=64");
  });
});

describe("isPlaceholderFavicon", () => {
  it("takes 16px and smaller as the resolver's own globe", () => {
    expect(isPlaceholderFavicon(16)).toBe(true);
    expect(isPlaceholderFavicon(0)).toBe(true);
    expect(isPlaceholderFavicon(32)).toBe(false);
  });
});
