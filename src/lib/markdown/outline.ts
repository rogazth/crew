import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export type OutlineItem = { level: number; text: string; from: number };

/** A heading's text as a reader sees it: links by their label, markers gone. */
export function plainHeading(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|==|~~|\*|_|`)(.+?)\1/g, "$2")
    .trim();
}

/** GitHub's anchor for a heading: `## Next Steps!` is `#next-steps`. */
export function slug(text: string): string {
  return plainHeading(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * The note's headings, top level only (a heading inside a quote is not a
 * section). The parse is finished if it can be quickly, so the outline of a
 * long note is not cut off where the viewport happened to stop.
 */
export function outlineOf(state: EditorState): OutlineItem[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const doc = state.doc;
  const out: OutlineItem[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const m = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!m) continue;
    let text = doc.lineAt(node.from).text;
    if (node.name.startsWith("ATX")) text = text.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+#+\s*$/, "");
    const plain = plainHeading(text);
    if (plain) out.push({ level: Number(m[1]), text: plain, from: node.from });
  }
  return out;
}

/** The heading a link's `#fragment` names, by its text or its GitHub slug. */
export function findHeading(items: OutlineItem[], wanted: string): OutlineItem | undefined {
  const text = wanted.trim().toLowerCase();
  return items.find((h) => h.text.toLowerCase() === text) ?? items.find((h) => slug(h.text) === slug(wanted));
}
