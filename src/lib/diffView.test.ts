import { describe, expect, it, vi } from "vitest";
import { fenceDiffs, fenceSides, snippetFile } from "./diffView";

describe("snippetFile", () => {
  it("ends the contents with a newline", () => {
    expect(snippetFile("a.ts", "x")).toEqual({ name: "a.ts", contents: "x\n" });
    expect(snippetFile("a.ts", "x\n")).toEqual({ name: "a.ts", contents: "x\n" });
  });

  it("is no file at all when empty", () => {
    expect(snippetFile("a.ts", "")).toBeNull();
  });
});

describe("fenceSides", () => {
  it("rebuilds before and after from bare +/- lines", () => {
    expect(fenceSides(" keep\n-old\n+new\nplain")).toEqual({ before: "keep\nold\nplain", after: "keep\nnew\nplain" });
  });
});

describe("fenceDiffs", () => {
  const sides = (before: string, after: string) => ({ before, after });

  it("takes a real patch as it is", () => {
    const patch = vi.fn(() => [{ before: "p", after: "q" }]);
    const code = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
    expect(fenceDiffs(code, { patch, sides })).toEqual([{ before: "p", after: "q" }]);
    expect(patch).toHaveBeenCalledWith(code);
  });

  it("never asks the patch parser without a hunk header", () => {
    const patch = vi.fn(() => []);
    expect(fenceDiffs("-a\n+b", { patch, sides })).toEqual([{ before: "a", after: "b" }]);
    expect(patch).not.toHaveBeenCalled();
  });

  it("walks the lines when the patch has no files or does not parse", () => {
    const code = "@@ nonsense\n-a\n+b";
    expect(fenceDiffs(code, { patch: () => [], sides })).toEqual([{ before: "@@ nonsense\na", after: "@@ nonsense\nb" }]);
    const broken = () => {
      throw new Error("bad patch");
    };
    expect(fenceDiffs(code, { patch: broken, sides })).toEqual([{ before: "@@ nonsense\na", after: "@@ nonsense\nb" }]);
  });
});
