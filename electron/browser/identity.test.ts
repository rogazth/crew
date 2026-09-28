import { describe, expect, it } from "vitest";
import { chromeUserAgent, firefoxUserAgent, isGoogleSignIn, outgoingHeaders, withChromeBrand } from "./identity";

describe("chromeUserAgent", () => {
  // Electron 44.2's default, read from app.userAgentFallback.
  const linux =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Crew/0.1.4 Chrome/152.0.7977.76 Electron/44.2.0 Safari/537.36";
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Crew/0.1.4 Chrome/152.0.7977.76 Electron/44.2.0 Safari/537.36";

  it("reads as Chrome's own agent, with the version Chrome reports", () => {
    expect(chromeUserAgent(linux)).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    );
    expect(chromeUserAgent(mac)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    );
  });

  it("strips the app token in any case", () => {
    expect(chromeUserAgent(linux.replace("Crew/", "crew/"))).not.toMatch(/crew/i);
    expect(chromeUserAgent(linux.replace("Crew/0.1.4", "CREW/1.0.0-beta.2"))).not.toMatch(/crew/i);
  });

  it("keeps words that merely contain the app name", () => {
    expect(chromeUserAgent("Mozilla/5.0 Screw/1.0 Chrome/152.0.0.0")).toBe("Mozilla/5.0 Screw/1.0 Chrome/152.0.0.0");
  });

  it("is stable when applied twice", () => {
    expect(chromeUserAgent(chromeUserAgent(mac))).toBe(chromeUserAgent(mac));
  });
});

describe("firefoxUserAgent", () => {
  it("names the platform Firefox would", () => {
    expect(firefoxUserAgent("darwin")).toMatch(/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10\.15; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/);
    expect(firefoxUserAgent("win32")).toContain("Windows NT 10.0");
    expect(firefoxUserAgent("linux")).toContain("X11; Linux x86_64");
    expect(firefoxUserAgent("darwin")).not.toMatch(/Chrome|Electron|crew/i);
  });
});

describe("isGoogleSignIn", () => {
  it.each([
    ["https://accounts.google.com/v3/signin/identifier?x=1", true],
    ["https://ACCOUNTS.GOOGLE.COM/", true],
    ["http://accounts.google.com/", false],
    ["https://mail.google.com/", false],
    ["https://accounts.google.com.evil.com/", false],
    ["https://evil.com/accounts.google.com", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isGoogleSignIn(url)).toBe(expected);
  });
});

describe("withChromeBrand", () => {
  const hints = '"Chromium";v="152", "Not)A;Brand";v="24"';

  it("adds Google Chrome beside Chromium and its GREASE brand", () => {
    expect(withChromeBrand(hints, "152")).toBe('"Chromium";v="152", "Not)A;Brand";v="24", "Google Chrome";v="152"');
  });

  it("leaves a list that already names Chrome", () => {
    const chrome = `${hints}, "Google Chrome";v="152"`;
    expect(withChromeBrand(chrome, "152")).toBe(chrome);
  });

  it("builds a list from nothing", () => {
    expect(withChromeBrand("", "152")).toBe('"Google Chrome";v="152"');
  });
});

describe("outgoingHeaders", () => {
  const chrome = { major: "152", full: "152.0.7977.76" };
  const headers = {
    "User-Agent": "Mozilla/5.0 Chrome/152.0.0.0",
    "sec-ch-ua": '"Chromium";v="152", "Not)A;Brand";v="24"',
    "sec-ch-ua-full-version-list": '"Chromium";v="152.0.7977.76", "Not)A;Brand";v="24.0.0.0"',
    "sec-ch-ua-mobile": "?0",
    Accept: "text/html",
  };

  it("names Chrome in the client hints everywhere else", () => {
    const out = outgoingHeaders(headers, "https://github.com/", chrome);
    expect(out["sec-ch-ua"]).toContain('"Google Chrome";v="152"');
    expect(out["sec-ch-ua-full-version-list"]).toContain('"Google Chrome";v="152.0.7977.76"');
    expect(out["User-Agent"]).toBe(headers["User-Agent"]);
    expect(out.Accept).toBe("text/html");
  });

  it("goes as Firefox, with no client hints, on Google's sign-in", () => {
    const out = outgoingHeaders(headers, "https://accounts.google.com/ServiceLogin", chrome);
    expect(out["User-Agent"]).toMatch(/Firefox\/\d+/);
    expect(Object.keys(out).filter((name) => name.toLowerCase().startsWith("sec-ch-ua"))).toEqual([]);
    expect(out.Accept).toBe("text/html");
  });

  it("does not add headers a request didn't carry", () => {
    expect(outgoingHeaders({ Accept: "*/*" }, "https://github.com/", chrome)).toEqual({ Accept: "*/*" });
  });
});
