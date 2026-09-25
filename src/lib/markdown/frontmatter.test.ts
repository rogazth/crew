import { describe, expect, it } from "vitest";
import { parseProperties } from "./frontmatter";

describe("parseProperties", () => {
  it("reads scalars, flow lists and block lists", () => {
    const source = '---\ntitle: "Plan"\ntags: [a, b]\naliases:\n  - one\n  - two\nempty:\n---';
    expect(parseProperties(source).map(({ key, value }) => [key, value])).toEqual([
      ["title", "Plan"],
      ["tags", ["a", "b"]],
      ["aliases", ["one", "two"]],
      ["empty", ""],
    ]);
  });

  it("keeps each key's offset in the block", () => {
    const source = "---\na: 1\nb: 2\n---";
    const b = parseProperties(source)[1]!;
    expect(source.slice(b.from, b.from + 4)).toBe("b: 2");
  });

  it("does not split a URL value on its colon", () => {
    expect(parseProperties("---\nsource: https://x.dev/a\n---")[0]!.value).toBe("https://x.dev/a");
  });
});
