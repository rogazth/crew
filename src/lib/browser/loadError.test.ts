import { describe, expect, it } from "vitest";
import { classifyLoadFailure, describeLoadError } from "./loadError";

const failure = (patch: Partial<Parameters<typeof classifyLoadFailure>[0]> = {}) => ({
  errorCode: -102,
  errorDescription: "ERR_CONNECTION_REFUSED",
  validatedURL: "http://localhost:3000/",
  isMainFrame: true,
  ...patch,
});

describe("classifyLoadFailure", () => {
  it("reports a real main-frame failure", () => {
    expect(classifyLoadFailure(failure(), "http://fallback/")).toEqual({
      code: -102,
      description: "ERR_CONNECTION_REFUSED",
      url: "http://localhost:3000/",
    });
  });

  it("ignores ERR_ABORTED, which a redirect race reports even when the page loads", () => {
    expect(classifyLoadFailure(failure({ errorCode: -3, errorDescription: "ERR_ABORTED" }), "")).toBeNull();
  });

  it("ignores a subframe that failed", () => {
    expect(classifyLoadFailure(failure({ isMainFrame: false }), "")).toBeNull();
  });

  it("ignores code 0, which is not an error", () => {
    expect(classifyLoadFailure(failure({ errorCode: 0 }), "")).toBeNull();
  });

  it("falls back to the attempted URL when Chromium gives none", () => {
    expect(classifyLoadFailure(failure({ validatedURL: "" }), "http://fallback/")?.url).toBe("http://fallback/");
  });

  it("says something when Chromium gives no description", () => {
    expect(classifyLoadFailure(failure({ errorDescription: "" }), "")?.description).toBe("Unknown error");
  });
});

describe("describeLoadError", () => {
  it("has copy for the failures people actually hit", () => {
    for (const code of [-100, -101, -102, -105, -106, -109, -118, -310, -324]) {
      const { title, detail } = describeLoadError(code);
      expect(title).not.toBe(describeLoadError(-9999).title);
      expect(detail).not.toBe("");
    }
  });

  it("points at a dev server that is not running when the connection is refused", () => {
    expect(describeLoadError(-102).detail).toMatch(/dev server/);
  });

  it("files the whole -200 range under certificates", () => {
    expect(describeLoadError(-200).title).toBe("Certificate problem.");
    expect(describeLoadError(-202).title).toBe("Certificate problem.");
    expect(describeLoadError(-299).title).toBe("Certificate problem.");
    expect(describeLoadError(-300).title).not.toBe("Certificate problem.");
  });

  it("names the code when it has nothing better to say", () => {
    expect(describeLoadError(-9999).detail).toContain("-9999");
  });
});
