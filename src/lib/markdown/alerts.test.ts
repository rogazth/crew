import type { Blockquote, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { fenceTitle, remarkAlerts } from "./alerts";

function quote(value: string): Root {
  return {
    type: "root",
    children: [{ type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value }] }] }],
  };
}

function run(tree: Root): Blockquote {
  remarkAlerts()(tree);
  return tree.children[0] as Blockquote;
}

describe("remarkAlerts", () => {
  it("moves the marker onto the quote and out of the text", () => {
    const node = run(quote("[!NOTE]\nCallouts render with an icon."));
    expect(node.data?.hProperties).toEqual({ dataAlert: "note" });
    expect(node.children[0]).toMatchObject({ children: [{ value: "Callouts render with an icon." }] });
  });

  it("keeps a title the marker named", () => {
    const node = run(quote("[!warning]- Breaking\nThe API moved."));
    expect(node.data?.hProperties).toEqual({ dataAlert: "warning", dataAlertTitle: "Breaking" });
  });

  it("drops a paragraph the marker was all of", () => {
    const node = run(quote("[!TIP]"));
    expect(node.children).toHaveLength(0);
  });

  it("leaves a plain quote alone", () => {
    const node = run(quote("Just a quote."));
    expect(node.data).toBeUndefined();
  });
});

describe("fenceTitle", () => {
  it("reads a title attribute, quoted or not", () => {
    expect(fenceTitle('title="src/a.ts"')).toBe("src/a.ts");
    expect(fenceTitle("title=a.ts showLineNumbers")).toBe("a.ts");
  });

  it("reads a bare path", () => {
    expect(fenceTitle("src/lib/a.ts")).toBe("src/lib/a.ts");
  });

  it("ignores flags that are not paths", () => {
    expect(fenceTitle("showLineNumbers")).toBeUndefined();
    expect(fenceTitle("{1,3}")).toBeUndefined();
    expect(fenceTitle(undefined)).toBeUndefined();
  });
});
