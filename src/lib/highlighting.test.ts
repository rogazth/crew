import { bundledLanguages } from "shiki/langs";
import { describe, expect, it } from "vitest";
import { LANGS, TOKENIZE_MAX_LENGTH, TOKENIZE_MAX_LINE_LENGTH } from "./highlighting";

describe("highlighting", () => {
  it("curates only grammars shiki actually bundles", () => {
    const missing = LANGS.filter((lang) => !(lang in bundledLanguages));
    expect(missing).toEqual([]);
    expect(LANGS).not.toContain("text");
  });

  it("lists each grammar once", () => {
    expect(new Set(LANGS).size).toBe(LANGS.length);
  });

  it("caps a single line well below the whole file", () => {
    expect(TOKENIZE_MAX_LINE_LENGTH).toBeLessThan(TOKENIZE_MAX_LENGTH);
  });
});
