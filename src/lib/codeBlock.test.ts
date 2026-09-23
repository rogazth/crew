import { describe, expect, it } from "vitest";
import { codeLanguage, isDiffLang } from "./codeBlock";

describe("isDiffLang", () => {
  it("knows diff and patch fences in any case", () => {
    expect(isDiffLang("diff")).toBe(true);
    expect(isDiffLang("PATCH")).toBe(true);
    expect(isDiffLang("diffs")).toBe(false);
    expect(isDiffLang(undefined)).toBe(false);
  });
});

describe("codeLanguage", () => {
  it("resolves aliases to a grammar", () => {
    expect(codeLanguage("ts")).toBe("typescript");
    expect(codeLanguage("sh")).toBe("shellscript");
    expect(codeLanguage("json")).toBe("json");
  });

  it("is null for diffs, unknown languages and bare fences", () => {
    expect(codeLanguage("diff")).toBeNull();
    expect(codeLanguage("brainfuck")).toBeNull();
    expect(codeLanguage(undefined)).toBeNull();
  });
});
