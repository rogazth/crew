import { describe, expect, it } from "vitest";
import {
  addressParts,
  DEFAULT_SEARCH,
  displayUrl,
  filePathOf,
  isWebUrl,
  resolveAddress,
  sameDocument,
  siteSecurity,
  unicodeHost,
  type Address,
} from "./url";

const go = (url: string): Address => ({ kind: "url", url });
const google = (query: string): Address => ({
  kind: "search",
  query,
  url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
});

describe("resolveAddress", () => {
  const cases: Array<[string, Address]> = [
    ["", { kind: "empty" }],
    ["   ", { kind: "empty" }],

    // Local dev servers go to plain http.
    ["localhost", go("http://localhost")],
    ["localhost:3000", go("http://localhost:3000")],
    ["localhost:3000/a?b#c", go("http://localhost:3000/a?b#c")],
    ["127.0.0.1:8080/x?y", go("http://127.0.0.1:8080/x?y")],
    ["[::1]:5173", go("http://[::1]:5173")],
    ["0.0.0.0:3000", go("http://0.0.0.0:3000")],
    ["app.localhost:5173", go("http://app.localhost:5173")],
    ["localhost:99999", google("localhost:99999")],
    ["127.999.0.1", google("127.999.0.1")],

    // An explicit http(s) scheme is kept, and parsed.
    ["HTTP://Example.com", go("http://example.com/")],
    ["https://example.com/a b", go("https://example.com/a%20b")],
    ["https://bücher.de", go("https://xn--bcher-kva.de/")],
    ["http://[::1]:5173", go("http://[::1]:5173/")],
    ["https://", google("https://")],
    ["http://foo bar", google("http://foo bar")],

    ["about:blank", go("about:blank")],

    // A file, by URL or by absolute path, opens in its preview tab.
    ["file:///etc/passwd", go("file:///etc/passwd")],
    ["file:///tmp/a%20b/index.html?x#y", go("file:///tmp/a%20b/index.html")],
    ["/tmp/report/index.html", go("file:///tmp/report/index.html")],
    ["/tmp/my report.html", go("file:///tmp/my%20report.html")],
    ["file://server/share/a.html", google("file://server/share/a.html")],
    ["file:///tmp/", google("file:///tmp/")],
    ["/", google("/")],

    // Anything else with a scheme is searched for, never opened.
    ["javascript:alert(1)", google("javascript:alert(1)")],
    ["mailto:x@y", google("mailto:x@y")],
    ["chrome://settings", google("chrome://settings")],
    ["data:text/html,<b>hi</b>", google("data:text/html,<b>hi</b>")],
    ["javascript:1/x", google("javascript:1/x")],

    // Host-looking input gets https.
    ["example.com", go("https://example.com")],
    ["example.com/a?b#c", go("https://example.com/a?b#c")],
    ["EXAMPLE.com", go("https://EXAMPLE.com")],
    ["sub.example.co.uk", go("https://sub.example.co.uk")],
    ["example.com:8080/x", go("https://example.com:8080/x")],
    ["192.168.1.10:8000", go("http://192.168.1.10:8000")],
    ["10.0.0.5:3000/x", go("http://10.0.0.5:3000/x")],
    ["172.20.1.1", go("http://172.20.1.1")],
    ["172.32.1.1", go("https://172.32.1.1")],
    ["8.8.8.8", go("https://8.8.8.8")],
    ["mac-mini.local:8080", go("http://mac-mini.local:8080")],
    ["bücher.de", go("https://bücher.de")],
    ["example.xn--p1ai", go("https://example.xn--p1ai")],
    ["  example.com  ", go("https://example.com")],
    ["example.com:99999", google("example.com:99999")],

    // The rest is a search.
    ["foo bar", google("foo bar")],
    ["foo", google("foo")],
    ["foo.", google("foo.")],
    ["1.2", google("1.2")],
    ["example.com is down", google("example.com is down")],
    ["  foo bar  ", google("foo bar")],
  ];

  for (const [input, expected] of cases) {
    it(`resolves ${JSON.stringify(input)}`, () => {
      expect(resolveAddress(input)).toEqual(expected);
    });
  }

  it("fills the query into a custom template", () => {
    expect(resolveAddress("foo", "https://duckduckgo.com/?q=%s")).toEqual({
      kind: "search",
      query: "foo",
      url: "https://duckduckgo.com/?q=foo",
    });
  });

  it("encodes what would break the query string", () => {
    expect(resolveAddress("a&b #c")).toEqual({
      kind: "search",
      query: "a&b #c",
      url: "https://www.google.com/search?q=a%26b%20%23c",
    });
  });

  it("defaults to Google", () => {
    expect(DEFAULT_SEARCH).toBe("https://www.google.com/search?q=%s");
  });
});

describe("isWebUrl", () => {
  it("accepts http and https only", () => {
    expect(isWebUrl("https://example.com/")).toBe(true);
    expect(isWebUrl("http://localhost:3000/")).toBe(true);
    expect(isWebUrl("about:blank")).toBe(false);
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(filePathOf("file:///tmp/a%20b/index.html")).toBe("/tmp/a b/index.html");
    expect(filePathOf("https://example.com/a.html")).toBeNull();
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
  });
});

describe("displayUrl", () => {
  it("shows nothing for the blank page or junk", () => {
    expect(displayUrl("about:blank")).toBe("");
    expect(displayUrl("")).toBe("");
    expect(displayUrl("not a url")).toBe("");
  });

  it("shows any other URL as it is", () => {
    expect(displayUrl("https://example.com/a?b#c")).toBe("https://example.com/a?b#c");
  });
});

describe("sameDocument", () => {
  it("ignores the fragment", () => {
    expect(sameDocument("https://example.com/a#one", "https://example.com/a#two")).toBe(true);
    expect(sameDocument("https://example.com/a", "https://example.com/a#top")).toBe(true);
  });

  it("tells a pushState to another path apart", () => {
    expect(sameDocument("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(sameDocument("https://example.com/a?x=1", "https://example.com/a?x=2")).toBe(false);
  });

  it("still answers for URLs that do not parse", () => {
    expect(sameDocument("not a url#x", "not a url#y")).toBe(true);
  });
});

describe("addressParts", () => {
  const host = (h: string, path = "") => ({ kind: "host" as const, host: h, path });
  const cases: Array<[string, ReturnType<typeof addressParts>]> = [
    ["https://example.com/", host("example.com")],
    ["http://example.com/", host("example.com")],
    ["https://www.example.com/a/b?c=1#d", host("example.com", "/a/b?c=1#d")],
    ["https://example.com/?q=1", host("example.com", "/?q=1")],
    ["https://www.com/", host("www.com")],
    // The port is part of where the page is.
    ["http://localhost:3000/app", host("localhost:3000", "/app")],
    ["https://example.com:8443/", host("example.com:8443")],
    ["https://example.com:443/", host("example.com")],
    ["http://127.0.0.1:8080/x", host("127.0.0.1:8080", "/x")],
    ["http://[::1]:5173/", host("[::1]:5173")],
    ["http://192.168.1.10/", host("192.168.1.10")],
    // A user name or password is never shown, and never read as the host.
    ["https://user:secret@example.com/a", host("example.com", "/a")],
    ["https://google.com@evil.example/login", host("evil.example", "/login")],
    // Escapes read as text, except those that would hide something.
    ["https://example.com/caf%C3%A9", host("example.com", "/café")],
    ["https://example.com/a%20b", host("example.com", "/a%20b")],
    ["https://example.com/%E2%80%AEtxt.exe", host("example.com", "/%E2%80%AEtxt.exe")],
    ["https://example.com/%E0%A4%A", host("example.com", "/%E0%A4%A")],
    // International names read in their own letters when that is safe.
    ["https://xn--bcher-kva.de/", host("bücher.de")],
    ["https://www.xn--bcher-kva.de/", host("bücher.de")],
    ["https://xn--80ak6aa92e.com/", host("xn--80ak6aa92e.com")],
    ["https://xn--d1acpjx3f.xn--p1ai/", host("яндекс.рф")],
    // A file: its folder, then its name.
    ["file:///Users/me/site/index.html", { kind: "file", folder: "/Users/me/site/", name: "index.html" }],
    ["file:///tmp/my%20report.html", { kind: "file", folder: "/tmp/", name: "my%20report.html" }],
    ["about:blank", null],
    ["data:text/html,hi", null],
    ["not a url", null],
  ];

  for (const [url, expected] of cases) {
    it(`splits ${url}`, () => {
      expect(addressParts(url)).toEqual(expected);
    });
  }

  it("keeps a very long path whole, for the bar to elide", () => {
    const path = `/${"segment/".repeat(200)}end`;
    expect(addressParts(`https://example.com${path}`)).toEqual(host("example.com", path));
  });
});

describe("unicodeHost", () => {
  it("leaves plain hosts alone", () => {
    expect(unicodeHost("example.com")).toBe("example.com");
  });

  it("shows Japanese and Korean labels", () => {
    expect(unicodeHost("xn--wgv71a119e.jp")).toBe("日本語.jp");
    expect(unicodeHost("xn--3e0b707e.kr")).toBe("한국.kr");
  });

  it("keeps a label mixing Latin and Cyrillic in punycode", () => {
    // "pаypal" with a Cyrillic а.
    expect(unicodeHost("xn--pypal-4ve.com")).toBe("xn--pypal-4ve.com");
  });

  it("keeps punycode that does not decode", () => {
    expect(unicodeHost("xn--.com")).toBe("xn--.com");
    expect(unicodeHost("xn--zz!.com")).toBe("xn--zz!.com");
  });
});

describe("siteSecurity", () => {
  const cases: Array<[string, ReturnType<typeof siteSecurity>]> = [
    ["https://example.com/", "secure"],
    ["http://example.com/", "insecure"],
    ["http://192.168.1.10:8000/", "insecure"],
    ["http://localhost:3000/", "local"],
    ["https://localhost:3000/", "local"],
    ["http://127.0.0.1:8080/", "local"],
    ["http://[::1]:5173/", "local"],
    ["http://sandbox.localhost:3000/", "local"],
    ["http://localhost.evil.com/", "insecure"],
    ["file:///tmp/a.html", "file"],
    ["crew-file://abc/a.html", "crew"],
    ["about:blank", "none"],
    ["", "none"],
    ["data:text/html,hi", "none"],
  ];
  for (const [url, expected] of cases) {
    it(`calls ${url || "an empty page"} ${expected}`, () => {
      expect(siteSecurity(url)).toBe(expected);
    });
  }
});
