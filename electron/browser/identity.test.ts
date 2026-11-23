import { describe, expect, it } from "vitest";
import { chromiumUserAgent, firefoxUserAgent, isGoogleSignIn, outgoingHeaders } from "./identity";

describe("firefoxUserAgent", () => {
  it("names the platform Firefox would", () => {
    expect(firefoxUserAgent("darwin")).toMatch(/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10\.15; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/);
    expect(firefoxUserAgent("win32")).toContain("Windows NT 10.0");
    expect(firefoxUserAgent("linux")).toContain("X11; Linux x86_64");
    expect(firefoxUserAgent("darwin")).not.toMatch(/Chrome|Electron|crew/i);
  });
});

describe("chromiumUserAgent", () => {
  const tail = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Crew/0.8.2 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36",
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`,
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Electron/44.9.3 crew-dev/0.0.1 Safari/537.36",
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${tail}`,
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/44.9.3 crew/0.8.2 Chrome/152.0.7977.167 Safari/537.36",
      `Mozilla/5.0 (X11; Linux x86_64) ${tail}`,
    ],
  ])("drops the app's and Electron's tokens from %s", (agent, expected) => {
    expect(chromiumUserAgent(agent)).toBe(expected);
  });

  it("leaves an agent that is already plain as it is", () => {
    const plain = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`;
    expect(chromiumUserAgent(plain)).toBe(plain);
  });

  it.each(["", "Chrome", "Mozilla/5.0 Chrome/140 Electron/44.2.0", "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/152.0.0.0"])(
    "leaves an agent of another shape as it is: %j",
    (agent) => {
      expect(chromiumUserAgent(agent)).toBe(agent);
    },
  );
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

describe("outgoingHeaders", () => {
  const headers = {
    "User-Agent": "Mozilla/5.0 Chrome/152.0.0.0",
    "sec-ch-ua": '"Chromium";v="152", "Not)A;Brand";v="24"',
    "sec-ch-ua-full-version-list": '"Chromium";v="152.0.7977.76", "Not)A;Brand";v="24.0.0.0"',
    "sec-ch-ua-mobile": "?0",
    Accept: "text/html",
  };

  it("leaves a request elsewhere as it is", () => {
    expect(outgoingHeaders(headers, "https://dash.cloudflare.com/login")).toEqual(headers);
  });

  it("goes as Firefox, with no client hints, on Google's sign-in", () => {
    const out = outgoingHeaders(headers, "https://accounts.google.com/ServiceLogin");
    expect(out["User-Agent"]).toMatch(/Firefox\/\d+/);
    expect(Object.keys(out).filter((name) => name.toLowerCase().startsWith("sec-ch-ua"))).toEqual([]);
    expect(out.Accept).toBe("text/html");
  });

  it("does not add headers a request didn't carry", () => {
    expect(outgoingHeaders({ Accept: "*/*" }, "https://accounts.google.com/")).toEqual({ Accept: "*/*" });
  });
});
