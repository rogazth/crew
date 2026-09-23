import { describe, expect, it } from "vitest";
import { codeText, fenceLang, isFileLike, linkTarget, runKind } from "./markdown";

describe("codeText", () => {
  it("spells strings, arrays and nothing", () => {
    expect(codeText("a.ts")).toBe("a.ts");
    expect(codeText(["let ", "x"])).toBe("let x");
    expect(codeText(undefined)).toBe("");
    expect(codeText(null)).toBe("");
    expect(codeText(42)).toBe("42");
  });
});

describe("fenceLang", () => {
  it("reads the language class streamdown puts on a fence", () => {
    expect(fenceLang("language-ts")).toBe("ts");
    expect(fenceLang("shiki language-c++ other")).toBe("c++");
    expect(fenceLang("language-objective-c")).toBe("objective-c");
  });

  it("is undefined for a bare fence", () => {
    expect(fenceLang(undefined)).toBeUndefined();
    expect(fenceLang("")).toBeUndefined();
  });
});

describe("isFileLike", () => {
  it("takes paths with an extension", () => {
    expect(isFileLike("src/lib/tabs.ts")).toBe(true);
    expect(isFileLike("README.md")).toBe(true);
    expect(isFileLike("./x.css")).toBe(true);
    expect(isFileLike("@scope/pkg/index.js")).toBe(true);
  });

  it("leaves code, spaces and dotfiles as code", () => {
    expect(isFileLike("npm run build")).toBe(false);
    expect(isFileLike("foo()")).toBe(false);
    expect(isFileLike("src/lib")).toBe(false);
    expect(isFileLike("a.b.verylongext")).toBe(false);
    expect(isFileLike(".env")).toBe(false);
  });
});

describe("linkTarget", () => {
  it("sends web links out with a site icon", () => {
    expect(linkTarget("https://example.com/x")).toEqual({
      url: "https://example.com/x",
      anchor: undefined,
      web: "https://example.com/x",
    });
  });

  it("sends other schemes out without one", () => {
    expect(linkTarget("mailto:a@b.c")).toEqual({ url: "mailto:a@b.c", anchor: undefined, web: undefined });
  });

  it("keeps a footnote's #id inside the message", () => {
    expect(linkTarget("#fn-1")).toEqual({ url: undefined, anchor: "fn-1", web: undefined });
    expect(linkTarget("#")).toEqual({ url: undefined, anchor: "", web: undefined });
  });

  it("goes nowhere for streamdown's own links or no href", () => {
    expect(linkTarget("streamdown:incomplete-link")).toEqual({ url: undefined, anchor: undefined, web: undefined });
    expect(linkTarget(undefined)).toEqual({ url: undefined, anchor: undefined, web: undefined });
    expect(linkTarget("")).toEqual({ url: undefined, anchor: undefined, web: undefined });
  });
});

describe("runKind", () => {
  it("keeps wide runs wide", () => {
    expect(runKind("wide", "# Title")).toBe("wide");
  });

  it("makes a heading on its own a label and the rest prose", () => {
    expect(runKind("prose", "## Plan\n")).toBe("label");
    expect(runKind("prose", "## Plan\nFirst, the tests.")).toBe("prose");
  });
});
