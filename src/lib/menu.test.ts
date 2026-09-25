import { describe, expect, it } from "vitest";
import { OPEN, SEPARATOR, tidy } from "./menu";

describe("tidy", () => {
  it("keeps separators only between actions", () => {
    expect(tidy([SEPARATOR, OPEN, SEPARATOR, SEPARATOR, OPEN, SEPARATOR])).toEqual([OPEN, SEPARATOR, OPEN]);
    expect(tidy([SEPARATOR])).toEqual([]);
  });
});
