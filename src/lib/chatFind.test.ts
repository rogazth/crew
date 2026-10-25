import { describe, expect, it } from "vitest";
import { findTerms, matchOffsets } from "./chatFind";

const marked = (text: string, query: string) =>
  matchOffsets(text, findTerms(query)).map(([from, to]) => text.slice(from, to));

describe("findTerms", () => {
  it("reads words as the index does: letters and digits, folded", () => {
    expect(findTerms("  Canción  v2.1 foo_bar ")).toEqual(["cancion", "v2", "1", "foo", "bar"]);
  });

  it("has nothing for punctuation alone", () => {
    expect(findTerms("-- ( ) ")).toEqual([]);
  });
});

describe("matchOffsets", () => {
  it("marks the last word as a prefix, so the marks follow typing", () => {
    expect(marked("The sidebar is sticky", "side")).toEqual(["side"]);
    expect(marked("The sidebar is sticky", "the side")).toEqual(["The", "side"]);
  });

  it("marks earlier words only whole, as FTS5 matched them", () => {
    expect(marked("sidebar side", "side bar")).toEqual(["side"]);
  });

  it("never starts a mark inside a word", () => {
    expect(marked("rebar and bar", "bar")).toEqual(["bar"]);
  });

  it("ignores case and accents, and keeps the original text's offsets", () => {
    const text = "La CANCIÓN de ayer";
    expect(marked(text, "cancion")).toEqual(["CANCIÓN"]);
    expect(marked("café crème", "creme")).toEqual(["crème"]);
  });

  it("counts offsets in UTF-16, past emoji", () => {
    expect(marked("🚀 deploy 🚀 deploy", "deploy")).toEqual(["deploy", "deploy"]);
  });

  it("merges marks that overlap into one", () => {
    expect(matchOffsets("deploy deployment", findTerms("deploy deploy"))).toEqual([[0, 6], [7, 13]]);
  });

  it("splits words on underscores, as unicode61 does", () => {
    expect(marked("find_terms", "terms")).toEqual(["terms"]);
  });
});
