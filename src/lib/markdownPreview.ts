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
import { openLink } from "./external";

/**
 * Obsidian's Live Preview: the text stays markdown, but its syntax is hidden
 * and rendered wherever the selection is not. Only the viewport is decorated,
 * so a long note costs what a screenful costs.
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

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const hidden = Decoration.replace({});
const inlineCode = Decoration.mark({ class: "cm-md-inline-code" });
const lineClass = (name: string) => Decoration.line({ class: name });

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
  const shown = (a: number, b: number) => editing && touches(state, a, b);
  const shownLines = (a: number, b: number) => editing && touchesLines(state, a, b);

  // A view plugin may not replace a line break; a range that spans one stays visible.
  const replace = (a: number, b: number, deco: Decoration = hidden) => {
    if (a < b && doc.lineAt(a).number === doc.lineAt(b).number) out.push(deco.range(a, b));
  };
  // A mark and the one space that separates it from the text: `# `, `> `, `- `.
  const withSpace = (b: number) => (doc.sliceString(b, b + 1) === " " ? b + 1 : b);
  const eachLine = (a: number, b: number, name: (line: number, first: boolean, last: boolean) => string) => {
    const first = doc.lineAt(a).number;
    const last = doc.lineAt(b).number;
    const start = Math.max(first, doc.lineAt(from).number);
    const end = Math.min(last, doc.lineAt(to).number);
    for (let n = start; n <= end; n++) {
      out.push(lineClass(name(n, n === first, n === last)).range(doc.line(n).from));
    }
  };

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node;
      switch (ref.name) {
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
        case "InlineCode": {
          if (ref.name === "InlineCode") out.push(inlineCode.range(ref.from, ref.to));
          if (shown(ref.from, ref.to)) return;
          const mark = ref.name === "InlineCode" ? "CodeMark" : ref.name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark";
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
          if (node.parent?.name !== "Blockquote") eachLine(ref.from, ref.to, () => "cm-md-quote");
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

        case "FencedCode":
        case "CodeBlock": {
          eachLine(ref.from, ref.to, (_, first, last) =>
            ["cm-md-block", first && "cm-md-block-first", last && "cm-md-block-last"].filter(Boolean).join(" "),
          );
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
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The URL under a position: a link's destination, an autolink, or a bare URL. */
function urlAt(state: EditorState, pos: number): string | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "URL") return state.doc.sliceString(node.from, node.to);
    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? state.doc.sliceString(url.from, url.to) : null;
    }
  }
  return null;
}

/** A rendered link opens on click; in source, ⌘-click opens it. */
const links = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    const rendered = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-url]") : null;
    let url = rendered?.dataset.url ?? null;
    if (!url && (event.metaKey || event.ctrlKey)) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      url = pos === null ? null : urlAt(view.state, pos);
    }
    if (!url) return false;
    event.preventDefault();
    openLink(url);
    return true;
  },
});

export const markdownPreview = [preview, links];
