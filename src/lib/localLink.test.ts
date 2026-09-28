import { describe, expect, it } from "vitest";
import { localPath } from "./localLink";

describe("localPath", () => {
  it("reads absolute, relative and file:// links as files", () => {
    expect(localPath("/tmp/cl/repo/codex/src/math.js")).toBe("/tmp/cl/repo/codex/src/math.js");
    expect(localPath("src/math.js")).toBe("src/math.js");
    expect(localPath("./NOTES.md")).toBe("./NOTES.md");
    expect(localPath("file:///Users/me/a%20b.ts")).toBe("/Users/me/a b.ts");
  });

  it("drops the line a link points into", () => {
    expect(localPath("/repo/src/a.ts:12")).toBe("/repo/src/a.ts");
    expect(localPath("/repo/src/a.ts:12:3")).toBe("/repo/src/a.ts");
    expect(localPath("src/a.ts#L12")).toBe("src/a.ts");
    expect(localPath("src/a.ts#L3-L9")).toBe("src/a.ts");
  });

  it("leaves the web, anchors and words alone", () => {
    expect(localPath("https://example.com/a.js")).toBeNull();
    expect(localPath("mailto:a@b.co")).toBeNull();
    expect(localPath("#fn-1")).toBeNull();
    expect(localPath("//cdn.example.com/x.js")).toBeNull();
    expect(localPath("docs")).toBeNull();
    expect(localPath(undefined)).toBeNull();
  });
});
