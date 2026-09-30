import { describe, expect, it } from "vitest";
import { previewRuns } from "./searchPreview";

describe("previewRuns", () => {
  it("marks each match, shifted by where the preview starts", () => {
    const line = { line: 1, preview: "const deploy = deploy();", previewStart: 4, ranges: [[10, 16], [19, 25]] as [number, number][] };
    expect(previewRuns(line)).toEqual([
      { text: "const ", hit: false },
      { text: "deploy", hit: true },
      { text: " = ", hit: false },
      { text: "deploy", hit: true },
      { text: "();", hit: false },
    ]);
  });

  it("clips matches that run past the window, and drops the ones outside it", () => {
    const line = { line: 1, preview: "abcdef", previewStart: 10, ranges: [[2, 5], [8, 12], [15, 30]] as [number, number][] };
    expect(previewRuns(line)).toEqual([
      { text: "ab", hit: true },
      { text: "cde", hit: false },
      { text: "f", hit: true },
    ]);
  });
});
