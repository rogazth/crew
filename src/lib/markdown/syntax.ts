import { Language } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { Input } from "@lezer/common";
import { Tag, tags } from "@lezer/highlight";
import type { BlockContext, Line, MarkdownConfig, MarkdownParser } from "@lezer/markdown";

/**
 * What Obsidian reads on top of GFM: YAML frontmatter, `==highlight==` and
 * `[[wikilinks]]`. Each is a lezer extension, so the preview, the highlighter
 * and the tests all see the same tree.
 */

export const markTags = {
  highlight: Tag.define(),
  wikilink: Tag.define(tags.link),
};

const PUNCTUATION = /[\p{P}\p{S}]/u;
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/** `==text==`, flanked like `~~strike~~`: `a == b` stays text. */
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": markTags.highlight } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

/**
 * `[[target#heading|alias]]`, and `![[target]]` for an embed. The target is
 * kept whole (heading included); splitting it is the resolver's job.
 */
const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink", style: markTags.wikilink },
    { name: "WikiEmbed", style: markTags.wikilink },
    { name: "WikiLinkMark", style: tags.processingInstruction },
    { name: "WikiLinkTarget" },
    { name: "WikiLinkAlias" },
  ],
  parseInline: [
    {
      name: "WikiLink",
      parse(cx, next, pos) {
        const embed = next === 33; /* ! */
        const open = embed ? pos + 1 : pos;
        if ((!embed && next !== 91) || cx.char(open) !== 91 || cx.char(open + 1) !== 91) return -1;
        const start = open + 2;
        let close = -1;
        for (let i = start; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10 || c === 91) return -1;
          if (c === 93 /* ] */) {
            if (cx.char(i + 1) !== 93) return -1;
            close = i;
            break;
          }
        }
        if (close <= start) return -1;
        const pipe = cx.slice(start, close).indexOf("|");
        const targetEnd = pipe < 0 ? close : start + pipe;
        const children = [cx.elt("WikiLinkMark", pos, start), cx.elt("WikiLinkTarget", start, targetEnd)];
        if (pipe >= 0) {
          children.push(cx.elt("WikiLinkMark", targetEnd, targetEnd + 1));
          children.push(cx.elt("WikiLinkAlias", targetEnd + 1, close));
        }
        children.push(cx.elt("WikiLinkMark", close, close + 2));
        return cx.addElement(cx.elt(embed ? "WikiEmbed" : "WikiLink", pos, close + 2, children));
      },
      before: "Link",
    },
  ],
};

const FENCE = /^---\s*$/;
const FENCE_END = /^(?:---|\.\.\.)\s*$/;
/** Past this many lines an opening `---` is a rule, not the start of properties. */
const MAX_FRONTMATTER_LINES = 500;

/**
 * Whether the document's first line opens a frontmatter block that closes.
 * Block parsers cannot look further than one line ahead, and an unclosed
 * `---` must stay a rule: consuming lines first would leave nothing to undo.
 */
function closesFrontmatter(cx: BlockContext): boolean {
  // Not public API, but stable since 1.0: the context keeps the input it parses.
  const input = (cx as unknown as { input?: Input }).input;
  if (!input) return false;
  const text = input.read(0, Math.min(input.length, 64 * 1024));
  const lines = text.split("\n", MAX_FRONTMATTER_LINES + 1);
  // The last split piece may be a line cut at the read limit.
  return lines.slice(1, lines.length - (text.length === input.length ? 0 : 1)).some((l) => FENCE_END.test(l));
}

/** YAML between `---` fences on the very first line, as Obsidian and Jekyll read it. */
const Frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: "Frontmatter", block: true, style: tags.meta },
    { name: "FrontmatterMark", style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: "Frontmatter",
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || cx.parentType().name !== "Document" || !FENCE.test(line.text)) return false;
        if (!closesFrontmatter(cx)) return false;
        const marks = [cx.elt("FrontmatterMark", 0, 3)];
        while (cx.nextLine()) {
          if (FENCE_END.test(line.text)) {
            marks.push(cx.elt("FrontmatterMark", cx.lineStart, cx.lineStart + 3));
            const end = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(cx.elt("Frontmatter", 0, end, marks));
            return true;
          }
        }
        cx.addElement(cx.elt("Frontmatter", 0, cx.prevLineEnd(), marks));
        return true;
      },
      before: "HorizontalRule",
    },
  ],
};

const parser = (markdownLanguage.parser as MarkdownParser).configure([Frontmatter, Highlight, WikiLink]);

/**
 * GFM plus the extensions above. Sharing `markdownLanguage.data` keeps the
 * list keymap and paste-as-link, which check for that language, working here.
 */
export const obsidianMarkdown = new Language(markdownLanguage.data, parser, [], "markdown");
