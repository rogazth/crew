import type { SyntaxNode } from "@lezer/common";
import { obsidianMarkdown } from "./syntax";

/**
 * Inline markdown as DOM, for text a widget shows in place of its source
 * (table cells, property values). Built from nodes and text nodes only:
 * nothing from the note ever reaches `innerHTML`.
 */

const TAGS: Record<string, string> = {
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "s",
  Highlight: "mark",
  InlineCode: "code",
};

/** Syntax that is never shown: the marks around rendered text. */
const HIDDEN = /Mark$|^(?:URL|LinkTitle|LinkLabel|CodeInfo)$/;

function walk(node: SyntaxNode, text: string, into: Node) {
  let at = node.from;
  const gap = (to: number) => {
    if (to > at) into.appendChild(document.createTextNode(text.slice(at, to)));
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    gap(child.from);
    at = child.to;
    if (HIDDEN.test(child.name)) continue;
    const tag = TAGS[child.name];
    if (tag) {
      const el = document.createElement(tag);
      walk(child, text, el);
      into.appendChild(el);
    } else if (child.name === "Link" || child.name === "Autolink") {
      const url = child.getChild("URL");
      const a = document.createElement("span");
      a.className = "cm-md-link";
      if (url) a.dataset.url = text.slice(url.from, url.to);
      walk(child, text, a);
      into.appendChild(a);
    } else if (child.name === "WikiLink") {
      const target = child.getChild("WikiLinkTarget");
      const alias = child.getChild("WikiLinkAlias");
      const span = document.createElement("span");
      span.className = "cm-md-wikilink";
      if (target) span.dataset.wikilink = text.slice(target.from, target.to);
      const shown = alias ?? target;
      span.textContent = shown ? text.slice(shown.from, shown.to) : "";
      into.appendChild(span);
    } else if (child.name === "Escape") {
      into.appendChild(document.createTextNode(text.slice(child.from + 1, child.to)));
    } else {
      walk(child, text, into);
    }
  }
  gap(node.to);
}

export function renderInline(text: string, into: HTMLElement) {
  const tree = obsidianMarkdown.parser.parse(text);
  // A cell is one paragraph; whatever block the parser saw, render its inline content.
  for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
    walk(block, text, into);
  }
}
