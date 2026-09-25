import { describe, expect, it } from "vitest";
import { LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { findHeading, outlineOf, slug } from "./outline";
import { obsidianMarkdown } from "./syntax";

const outline = (doc: string) =>
  outlineOf(EditorState.create({ doc, extensions: new LanguageSupport(obsidianMarkdown) }));

describe("outlineOf", () => {
  it("lists top-level headings as plain text", () => {
    const doc = "---\ntitle: x\n---\n# One **bold**\n\n```\n# no\n```\n\nSub\n---\n\n> # quoted\n\n## [[Plan|Two]] ##";
    expect(outline(doc).map(({ level, text }) => [level, text])).toEqual([
      [1, "One bold"],
      [2, "Sub"],
      [2, "Two"],
    ]);
  });
});

describe("findHeading", () => {
  const items = outline("# Intro\n\n## Next Steps!\n");

  it("matches by text or by GitHub slug", () => {
    expect(findHeading(items, "next steps!")?.text).toBe("Next Steps!");
    expect(findHeading(items, "next-steps")?.text).toBe("Next Steps!");
    expect(findHeading(items, "nope")).toBeUndefined();
  });

  it("slugs like GitHub", () => {
    expect(slug("Next Steps!")).toBe("next-steps");
  });
});
