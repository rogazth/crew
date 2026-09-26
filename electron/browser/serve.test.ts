import { describe, expect, it } from "vitest";
import { servedPath, urlFor, within } from "./serve";

const ROOT = "/Users/me/repo";

describe("servedPath", () => {
  it.each([
    ["/report.html", "/Users/me/repo/report.html"],
    ["/out/My%20Report.html", "/Users/me/repo/out/My Report.html"],
    ["/out//a.css", "/Users/me/repo/out/a.css"],
    ["/", "/Users/me/repo"],
  ])("serves %s", (pathname, expected) => {
    expect(servedPath(ROOT, pathname)).toBe(expected);
  });

  it.each([
    ["a parent", "/../secret"],
    ["an encoded parent", "/%2e%2e/secret"],
    ["an encoded slash parent", "/out%2F..%2F..%2Fsecret"],
    ["a dotfile", "/.env"],
    ["a hidden folder", "/.git/config"],
    ["a backslash", "/out%5C..%5Csecret"],
    ["a NUL", "/a%00.html"],
    ["a malformed escape", "/%E0%A4%A"],
  ])("refuses %s", (_name, pathname) => {
    expect(servedPath(ROOT, pathname)).toBeNull();
  });
});

describe("within", () => {
  it("holds the root and what lies under it", () => {
    expect(within(ROOT, ROOT)).toBe(true);
    expect(within(ROOT, `${ROOT}/a/b.html`)).toBe(true);
  });

  it("refuses a sibling that shares the root's prefix", () => {
    expect(within(ROOT, "/Users/me/repo-other/a.html")).toBe(false);
    expect(within(ROOT, "/Users/me")).toBe(false);
  });
});

describe("urlFor", () => {
  it("encodes each segment under the host", () => {
    expect(urlFor("h1", ROOT, `${ROOT}/out/My Report#1.html`)).toBe("crew-file://h1/out/My%20Report%231.html");
  });

  it("refuses a file outside the root, or the root itself", () => {
    expect(urlFor("h1", ROOT, "/Users/me/other/a.html")).toBeNull();
    expect(urlFor("h1", ROOT, ROOT)).toBeNull();
    expect(urlFor("h1", "repo", `${ROOT}/a.html`)).toBeNull();
  });

  it("round-trips through servedPath", () => {
    const file = `${ROOT}/out/My Report#1.html`;
    const url = new URL(urlFor("h1", ROOT, file)!);
    expect(servedPath(ROOT, url.pathname)).toBe(file);
  });
});
