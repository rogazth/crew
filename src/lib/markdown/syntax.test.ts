import { describe, expect, it } from "vitest";
import { obsidianMarkdown } from "./syntax";

/** Top-level nodes and the inline ones worth asserting on, with their text. */
function nodes(doc: string, names: string[]) {
  const out: string[] = [];
  obsidianMarkdown.parser.parse(doc).iterate({
    enter: (node) => {
      if (names.includes(node.name)) out.push(`${node.name}:${doc.slice(node.from, node.to)}`);
    },
  });
  return out;
}

describe("frontmatter", () => {
  it("reads a closed block on the first line", () => {
    const doc = "---\ntitle: Hola\ntags: [a]\n---\n\n# H\n";
    expect(nodes(doc, ["Frontmatter", "SetextHeading2", "HorizontalRule", "ATXHeading1"])).toEqual([
      "Frontmatter:---\ntitle: Hola\ntags: [a]\n---",
      "ATXHeading1:# H",
    ]);
  });

  it("leaves an unclosed fence as a rule", () => {
    expect(nodes("---\ntext\n", ["Frontmatter", "HorizontalRule"])).toEqual(["HorizontalRule:---"]);
  });

  it("only counts at the very start", () => {
    expect(nodes("intro\n\n---\na: 1\n---\n", ["Frontmatter"])).toEqual([]);
  });
});

describe("highlight", () => {
  it("parses ==marked== text", () => {
    expect(nodes("a ==big== deal", ["Highlight"])).toEqual(["Highlight:==big=="]);
  });

  it("leaves a comparison alone", () => {
    expect(nodes("if a == b then", ["Highlight"])).toEqual([]);
  });
});

describe("wikilinks", () => {
  it("parses target, heading and alias", () => {
    expect(nodes("see [[Notes/Plan#Goals|the plan]] now", ["WikiLink", "WikiLinkTarget", "WikiLinkAlias"])).toEqual([
      "WikiLink:[[Notes/Plan#Goals|the plan]]",
      "WikiLinkTarget:Notes/Plan#Goals",
      "WikiLinkAlias:the plan",
    ]);
  });

  it("parses an embed", () => {
    expect(nodes("![[diagram.png]]", ["WikiEmbed", "Image"])).toEqual(["WikiEmbed:![[diagram.png]]"]);
  });

  it("does not take a regular link or an empty pair", () => {
    expect(nodes("[a](b) and [[]]", ["WikiLink"])).toEqual([]);
  });

  it("is plain code inside backticks", () => {
    expect(nodes("`[[x]]`", ["WikiLink"])).toEqual([]);
  });
});
