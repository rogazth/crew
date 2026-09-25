import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { imageSrc } from "../attachments";
import { isFolded, refreshPreview, toggleFold } from "./blocks";
import { calloutKind, defaultTitle, icon, parseCalloutHead } from "./callouts";
import { codeTokens, onHighlighted } from "./code";
import { noteHost, resolvePath, resolveWikiLink, splitTarget } from "./wikilinks";

/**
 * Obsidian's Live Preview: the text stays markdown, but its syntax is hidden
 * and rendered wherever the selection is not. Only the viewport is decorated,
 * so a long note costs what a screenful costs. Whole-block widgets (tables,
 * diagrams, properties) live in `blocks.ts`.
 */

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-md-bullet";
    dot.textContent = "•";
    return dot;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const rule = document.createElement("span");
    rule.className = "cm-md-rule";
    return rule;
  }
}

/** `[ ]` / `[x]` as a box; a click flips the character in the source. */
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-md-task";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    if (this.checked) {
      box.dataset.checked = "";
      box.textContent = "✓";
    }
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const at = view.posAtDOM(box) + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
}

/** The fence's language, in the corner of a rendered code block. */
class LanguageWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: LanguageWidget) {
    return other.lang === this.lang;
  }
  toDOM() {
    const label = document.createElement("span");
    label.className = "cm-md-code-lang";
    label.textContent = this.lang;
    return label;
  }
}

/** A callout's icon, its fold chevron, and the type's name when it has no title. */
class CalloutHeadWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly foldable: boolean,
    readonly folded: boolean,
    readonly title: string | null,
  ) {
    super();
  }
  eq(other: CalloutHeadWidget) {
    return (
      other.type === this.type &&
      other.foldable === this.foldable &&
      other.folded === this.folded &&
      other.title === this.title
    );
  }
  toDOM(view: EditorView) {
    const head = document.createElement("span");
    head.className = "cm-md-callout-head";
    head.append(icon(calloutKind(this.type).icon, "cm-md-callout-icon"));
    if (this.title) {
      const title = document.createElement("span");
      title.className = "cm-md-callout-default";
      title.textContent = this.title;
      head.append(title);
    }
    if (this.foldable) {
      const chevron = icon("caretRight", "cm-md-fold");
      chevron.setAttribute("aria-hidden", "false");
      chevron.setAttribute("role", "button");
      chevron.setAttribute("aria-label", this.folded ? "Expand" : "Collapse");
      chevron.setAttribute("aria-expanded", String(!this.folded));
      chevron.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const line = view.state.doc.lineAt(view.posAtDOM(head));
        view.dispatch({ effects: toggleFold.of(line.from) });
      });
      head.append(chevron);
    }
    return head;
  }
  ignoreEvent() {
    return false;
  }
}

/** An image in place of its markdown; a path is read from disk, a URL loads as is. */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.alt = this.alt;
    img.draggable = false;
    img.addEventListener("load", () => view.requestMeasure());
    const broken = () => {
      img.removeAttribute("src");
      img.dataset.broken = "";
      img.title = `Image not found: ${this.src}`;
      view.requestMeasure();
    };
    img.addEventListener("error", broken);
    if (/^(?:https?:|data:)/i.test(this.src)) img.src = this.src;
    else imageSrc(this.src).then((url) => (img.src = url), broken);
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const hidden = Decoration.replace({});
const inlineCode = Decoration.mark({ class: "cm-md-inline-code" });
const highlight = Decoration.mark({ class: "cm-md-highlight" });
const lineClass = (name: string, style?: string) =>
  Decoration.line(style ? { class: name, attributes: { style } } : { class: name });

/** One mark per distinct token color, shared across rebuilds. */
const tokenMarks = new Map<string, Decoration>();
function tokenMark(style: string): Decoration {
  let mark = tokenMarks.get(style);
  if (!mark) {
    mark = Decoration.mark({ class: "cm-md-token", attributes: { style } });
    tokenMarks.set(style, mark);
  }
  return mark;
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i;

/** Touching an edge counts: the caret right after `**` still shows the `**`. */
function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function touchesLines(state: EditorState, from: number, to: number): boolean {
  return touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
}

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) out.push(child);
  }
  return out;
}

/** `<a b.png>` and `a%20b.png` both name `a b.png`. */
function imagePath(url: string): string {
  const bare = url.replace(/^<|>$/g, "");
  try {
    return decodeURI(bare);
  } catch {
    return bare;
  }
}

/**
 * The decorations for [from, to]. `editing` is whether the editor has focus:
 * without it there is no caret to reveal syntax around, so everything renders.
 */
export function previewDecorations(
  state: EditorState,
  from: number,
  to: number,
  editing: boolean,
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const host = state.facet(noteHost);
  const shown = (a: number, b: number) => editing && touches(state, a, b);
  const shownLines = (a: number, b: number) => editing && touchesLines(state, a, b);

  // A view plugin may not replace a line break; a range that spans one stays visible.
  const replace = (a: number, b: number, deco: Decoration = hidden) => {
    if (a < b && doc.lineAt(a).number === doc.lineAt(b).number) out.push(deco.range(a, b));
  };
  // A mark and the one space that separates it from the text: `# `, `> `, `- `.
  const withSpace = (b: number) => (doc.sliceString(b, b + 1) === " " ? b + 1 : b);
  const eachLine = (
    a: number,
    b: number,
    name: (line: number, first: boolean, last: boolean) => string,
    style?: string,
  ) => {
    const first = doc.lineAt(a).number;
    const last = doc.lineAt(b).number;
    const start = Math.max(first, doc.lineAt(from).number);
    const end = Math.min(last, doc.lineAt(to).number);
    for (let n = start; n <= end; n++) {
      out.push(lineClass(name(n, n === first, n === last), style).range(doc.line(n).from));
    }
  };
  const blockLines = (a: number, b: number, base: string) =>
    eachLine(a, b, (_, first, last) => [base, first && `${base}-first`, last && `${base}-last`].filter(Boolean).join(" "));

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node;
      switch (ref.name) {
        case "Frontmatter": {
          blockLines(ref.from, ref.to, "cm-md-frontmatter");
          return false;
        }

        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
        case "SetextHeading1":
        case "SetextHeading2": {
          out.push(lineClass("cm-md-heading").range(doc.lineAt(ref.from).from));
          if (ref.name.startsWith("Setext") || shownLines(ref.from, ref.to)) return;
          const marks = children(node, "HeaderMark");
          const [open, close] = [marks[0], marks[1]];
          if (open) replace(open.from, withSpace(open.to));
          // A closing `##` takes the space before it.
          if (close) replace(doc.sliceString(close.from - 1, close.from) === " " ? close.from - 1 : close.from, close.to);
          return;
        }

        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough":
        case "Highlight":
        case "InlineCode": {
          if (ref.name === "InlineCode") out.push(inlineCode.range(ref.from, ref.to));
          if (ref.name === "Highlight") out.push(highlight.range(ref.from, ref.to));
          if (shown(ref.from, ref.to)) return;
          const marks: Record<string, string> = {
            InlineCode: "CodeMark",
            Strikethrough: "StrikethroughMark",
            Highlight: "HighlightMark",
          };
          const mark = marks[ref.name] ?? "EmphasisMark";
          for (const m of children(node, mark)) replace(m.from, m.to);
          return;
        }

        case "Link": {
          const url = node.getChild("URL");
          // `[foo]` alone is text until a definition says otherwise; lezer cannot know.
          if (!url && !node.getChild("LinkLabel")) return;
          const marks = children(node, "LinkMark");
          if (marks.length < 2 || shown(ref.from, ref.to)) return;
          const [open, close] = marks as [SyntaxNode, SyntaxNode];
          replace(open.from, open.to);
          replace(close.from, ref.to);
          if (url && open.to < close.from) {
            out.push(
              Decoration.mark({ class: "cm-md-link", attributes: { "data-url": doc.sliceString(url.from, url.to) } })
                .range(open.to, close.from),
            );
          }
          return;
        }

        case "Image": {
          const url = node.getChild("URL");
          if (!url || shown(ref.from, ref.to)) return false;
          const marks = children(node, "LinkMark");
          const alt = marks.length >= 2 ? doc.sliceString(marks[0]!.to, marks[1]!.from) : "";
          const raw = doc.sliceString(url.from, url.to);
          const src = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : resolvePath(host.path, imagePath(raw));
          replace(ref.from, ref.to, Decoration.replace({ widget: new ImageWidget(src, alt) }));
          return false;
        }

        case "WikiLink":
        case "WikiEmbed": {
          const target = node.getChild("WikiLinkTarget");
          if (!target) return false;
          const alias = node.getChild("WikiLinkAlias");
          const text = doc.sliceString(target.from, target.to);
          const { file } = splitTarget(text);
          const found = file ? resolveWikiLink(file, host.path, host.files) : null;
          const missing = file !== "" && !found;
          if (ref.name === "WikiEmbed" && found && IMAGE.test(found.name)) {
            if (!shown(ref.from, ref.to)) {
              const widget = new ImageWidget(found.path, alias ? doc.sliceString(alias.from, alias.to) : found.name);
              replace(ref.from, ref.to, Decoration.replace({ widget }));
            }
            return false;
          }
          const visible = alias ?? target;
          out.push(
            Decoration.mark({
              class: missing ? "cm-md-wikilink cm-md-wikilink-missing" : "cm-md-wikilink",
              attributes: { "data-wikilink": text },
            }).range(visible.from, visible.to),
          );
          if (!shown(ref.from, ref.to)) {
            replace(ref.from, visible.from);
            replace(visible.to, ref.to);
          }
          return false;
        }

        case "Autolink": {
          if (shown(ref.from, ref.to)) return;
          for (const m of children(node, "LinkMark")) replace(m.from, m.to);
          return;
        }

        case "ListMark": {
          const item = node.parent;
          if (item?.parent?.name !== "BulletList") return;
          if (shown(ref.from, ref.to + 1)) return;
          // A task's box stands in for the bullet.
          if (item.getChild("Task")) replace(ref.from, withSpace(ref.to));
          else replace(ref.from, ref.to, bullet);
          return;
        }

        case "Task": {
          const marker = node.getChild("TaskMarker");
          if (!marker) return;
          const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
          const text = withSpace(marker.to);
          if (checked && text < ref.to) out.push(Decoration.mark({ class: "cm-md-done" }).range(text, ref.to));
          if (!shown(marker.from, marker.to)) {
            replace(marker.from, marker.to, Decoration.replace({ widget: new TaskWidget(checked) }));
          }
          return;
        }

        case "Blockquote": {
          // Nested quotes share their parent's lines; one pass paints them.
          if (node.parent?.name === "Blockquote") return;
          const first = doc.lineAt(ref.from);
          const head = parseCalloutHead(first.text);
          if (!head) {
            eachLine(ref.from, ref.to, () => "cm-md-quote");
            return;
          }
          const style = `--callout: ${calloutKind(head.type).color}`;
          eachLine(
            ref.from,
            ref.to,
            (_, isFirst, isLast) =>
              ["cm-md-callout", isFirst && "cm-md-callout-title", isLast && "cm-md-callout-last"].filter(Boolean).join(" "),
            style,
          );
          if (first.to >= from && first.from <= to && !shownLines(first.from, first.to)) {
            const folded = head.fold !== null && isFolded(state, ref.from, head.fold === "-");
            const widget = new CalloutHeadWidget(head.type, head.fold !== null, folded, head.title ? null : defaultTitle(head.type));
            replace(first.from + head.markerFrom, first.from + head.titleFrom, Decoration.replace({ widget }));
          }
          return;
        }

        case "QuoteMark": {
          if (!shownLines(ref.from, ref.to)) replace(ref.from, withSpace(ref.to));
          return;
        }

        case "HorizontalRule": {
          if (!shownLines(ref.from, ref.to)) replace(ref.from, ref.to, rule);
          return;
        }

        case "FencedCode": {
          blockLines(ref.from, ref.to, "cm-md-block");
          const info = node.getChild("CodeInfo");
          const lang = info ? doc.sliceString(info.from, info.to).trim() : "";
          const code = node.getChild("CodeText");
          if (code && lang.toLowerCase() !== "mermaid") {
            const tokens = codeTokens(doc.sliceString(code.from, code.to), lang, ref.from) ?? [];
            for (const token of tokens) {
              const a = code.from + token.offset;
              const b = a + token.length;
              if (b > from && a < to) out.push(tokenMark(token.style).range(a, b));
            }
          }
          // Away from the caret the fences go quiet: the block's box says it is code.
          if (!shownLines(ref.from, ref.to)) {
            const [open, close] = children(node, "CodeMark");
            const firstLine = doc.lineAt(ref.from);
            if (open) {
              const end = info ? info.to : open.to;
              const deco = lang ? Decoration.replace({ widget: new LanguageWidget(lang) }) : hidden;
              replace(open.from, Math.min(end, firstLine.to), deco);
            }
            if (close && doc.lineAt(close.from).number !== firstLine.number) replace(close.from, close.to);
          }
          return false;
        }

        case "CodeBlock": {
          blockLines(ref.from, ref.to, "cm-md-block");
          return false;
        }

        case "Table": {
          eachLine(ref.from, ref.to, () => "cm-md-table");
          return false;
        }
      }
    },
  });

  return out;
}

function build(view: EditorView): DecorationSet {
  const { from, to } = view.viewport;
  return Decoration.set(previewDecorations(view.state, from, to, view.hasFocus), true);
}

const preview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    unsubscribe: () => void;
    constructor(view: EditorView) {
      this.decorations = build(view);
      // Code colors arrive async; a repaint is a no-op transaction the plugin reacts to.
      this.unsubscribe = onHighlighted(() => view.dispatch({ effects: refreshPreview.of(null) }));
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshPreview) || e.is(toggleFold))) ||
        update.startState.facet(noteHost) !== update.state.facet(noteHost) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = build(update.view);
      }
    }
    destroy() {
      this.unsubscribe();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const markdownPreview = preview;
