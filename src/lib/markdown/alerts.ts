import type { Blockquote, Parent, Root } from "mdast";

/** `[!NOTE]`, `[!warning]- Title`: the marker a callout's first line opens with. */
const MARK = /^\[!([\w-]+)\][+-]?[ \t]*([^\n]*)\n?/;

/**
 * GitHub's alerts and Obsidian's callouts (`> [!NOTE]`) for the chat. The
 * marker leaves the text and lands on the quote as `data-alert` (and
 * `data-alert-title` when it named one), which the chat's blockquote reads.
 */
export function remarkAlerts() {
  return (tree: Root) => walk(tree);
}

function walk(node: Parent) {
  for (const child of node.children) {
    if (child.type === "blockquote") mark(child);
    if ("children" in child) walk(child);
  }
}

function mark(quote: Blockquote) {
  const para = quote.children[0];
  if (para?.type !== "paragraph") return;
  const text = para.children[0];
  if (text?.type !== "text") return;
  const match = MARK.exec(text.value);
  if (!match) return;
  text.value = text.value.slice(match[0].length);
  if (!text.value) para.children.shift();
  if (para.children[0]?.type === "break") para.children.shift();
  if (para.children.length === 0) quote.children.shift();
  const title = match[2]!.trim();
  quote.data = {
    ...quote.data,
    hProperties: {
      ...(quote.data?.hProperties ?? {}),
      dataAlert: match[1]!.toLowerCase(),
      ...(title ? { dataAlertTitle: title } : {}),
    },
  };
}

/**
 * The file a fence names in its info string: ```` ```ts title="src/a.ts" ````,
 * or a bare path after the language, ```` ```ts src/a.ts ````.
 */
export function fenceTitle(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  const titled = /\btitle=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta);
  if (titled) return titled[1] ?? titled[2] ?? titled[3];
  const bare = meta.trim().split(/\s+/)[0];
  return bare && /[./]/.test(bare) && !bare.includes("=") ? bare : undefined;
}

/** What closes a sentence or a clause right after a link: the link's pill padding would open a gap before it. */
const CLOSING = /^[.,;:!?)\]}»”’…]/;

/**
 * A link a punctuation mark follows gets `data-tight`: its pill keeps no
 * room on the right, so "a link." does not read as "a link .".
 */
export function remarkTightLinks() {
  return (tree: Root) => tighten(tree);
}

function tighten(node: Parent) {
  node.children.forEach((child, index) => {
    const after = node.children[index + 1];
    if (child.type === "link" && after?.type === "text" && CLOSING.test(after.value)) {
      child.data = { ...child.data, hProperties: { ...(child.data?.hProperties ?? {}), dataTight: "" } };
    }
    if ("children" in child) tighten(child);
  });
}
