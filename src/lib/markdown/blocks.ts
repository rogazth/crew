import { syntaxTree } from "@codemirror/language";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { icon, parseCalloutHead } from "./callouts";
import { parseProperties } from "./frontmatter";
import { renderInline } from "./inline";
import { followRendered } from "./links";
import { isDark, renderMermaid, renderedMermaid } from "./mermaid";
import { parseTable, type Cell } from "./table";

/**
 * The block half of the live preview: whatever replaces whole lines (tables,
 * diagrams, properties, a folded callout's body). CodeMirror only takes those
 * from state, not from a view plugin, so this is a field over the whole note.
 * It walks top-level blocks only, which is cheap even for a long one.
 */

export const setFocused = StateEffect.define<boolean>();
/** Flips a foldable block (callout, properties) that starts at this position. */
export const toggleFold = StateEffect.define<number>();
/** Rebuild for something outside the state, such as the color scheme. */
export const refreshPreview = StateEffect.define<null>();

/** Without focus there is no caret to reveal source around, so everything renders. */
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocused)) value = effect.value;
    return value;
  },
});

/** Block starts whose fold state the user flipped from its default. */
const flipped = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(set, tr) {
    let next = set;
    if (tr.docChanged && set.size) next = new Set([...set].map((pos) => tr.changes.mapPos(pos)));
    for (const effect of tr.effects) {
      if (!effect.is(toggleFold)) continue;
      const copy = new Set(next);
      if (!copy.delete(effect.value)) copy.add(effect.value);
      next = copy;
    }
    return next;
  },
});

export function isFolded(state: EditorState, from: number, byDefault: boolean): boolean {
  return state.field(flipped).has(from) !== byDefault;
}

export function isFocused(state: EditorState): boolean {
  return state.field(focused);
}

/** Whether the selection is on any line of [from, to]: those lines show their source. */
export function revealed(state: EditorState, from: number, to: number): boolean {
  if (!state.field(focused)) return false;
  const a = state.doc.lineAt(from).from;
  const b = state.doc.lineAt(to).to;
  return state.selection.ranges.some((r) => r.from <= b && r.to >= a);
}

/** A click on a widget puts the caret at `offset` into its source, which reveals it. */
function editOnClick(dom: HTMLElement, view: EditorView, offsetOf: (target: Element) => number) {
  dom.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (followRendered(event.target, view)) return;
    const target = event.target instanceof Element ? event.target : dom;
    const pos = view.posAtDOM(dom) + offsetOf(target);
    view.focus();
    view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: false });
  });
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  get estimatedHeight() {
    return (this.source.split("\n").length - 1) * 33;
  }
  toDOM(view: EditorView) {
    const table = parseTable(this.source)!;
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const el = document.createElement("table");
    const columns = Math.max(table.header.length, ...table.rows.map((r) => r.length));
    const fill = (into: HTMLTableCellElement, cell: Cell | undefined, i: number) => {
      const align = table.align[i];
      if (align) into.style.textAlign = align;
      if (!cell) return;
      into.dataset.offset = String(cell.to);
      renderInline(cell.text, into);
    };
    const head = el.createTHead().insertRow();
    for (let i = 0; i < columns; i++) {
      const th = document.createElement("th");
      fill(th, table.header[i], i);
      head.append(th);
    }
    const body = el.createTBody();
    for (const row of table.rows) {
      const tr = body.insertRow();
      for (let i = 0; i < columns; i++) fill(tr.insertCell(), row[i], i);
    }
    wrap.append(el);
    editOnClick(wrap, view, (target) => Number(target.closest<HTMLElement>("[data-offset]")?.dataset.offset ?? 0));
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly dark: boolean,
  ) {
    super();
  }
  eq(other: MermaidWidget) {
    return other.source === this.source && other.dark === this.dark;
  }
  get estimatedHeight() {
    return 240;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-mermaid";
    const ready = renderedMermaid(this.source, this.dark);
    if (ready) {
      wrap.innerHTML = ready;
    } else {
      wrap.dataset.loading = "";
      renderMermaid(this.source, this.dark).then(
        (svg) => {
          delete wrap.dataset.loading;
          wrap.innerHTML = svg;
          view.requestMeasure();
        },
        (error: unknown) => {
          delete wrap.dataset.loading;
          wrap.dataset.error = "";
          const message = error instanceof Error ? error.message : String(error);
          wrap.textContent = `Mermaid: ${message.split("\n")[0]}`;
          view.requestMeasure();
        },
      );
    }
    // The first code line: the fence line is where the language is edited.
    editOnClick(wrap, view, () => view.state.doc.lineAt(view.posAtDOM(wrap)).length + 1);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class PropertiesWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly folded: boolean,
  ) {
    super();
  }
  eq(other: PropertiesWidget) {
    return other.source === this.source && other.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const properties = parseProperties(this.source);
    const wrap = document.createElement("div");
    wrap.className = "cm-md-props";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "cm-md-props-head";
    head.setAttribute("aria-expanded", String(!this.folded));
    head.append(icon("caretRight", "cm-md-fold"), "Properties");
    if (this.folded) {
      const count = document.createElement("span");
      count.className = "cm-md-props-count";
      count.textContent = String(properties.length);
      head.append(count);
    }
    head.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: toggleFold.of(view.posAtDOM(wrap)) });
    });
    wrap.append(head);

    if (!this.folded) {
      for (const property of properties) {
        const row = document.createElement("div");
        row.className = "cm-md-prop";
        row.dataset.offset = String(property.from + property.key.length + 1);
        const key = document.createElement("span");
        key.className = "cm-md-prop-key";
        key.textContent = property.key;
        const value = document.createElement("span");
        value.className = "cm-md-prop-value";
        if (Array.isArray(property.value)) {
          for (const item of property.value) {
            const chip = document.createElement("span");
            chip.className = "cm-md-chip";
            renderInline(item, chip);
            value.append(chip);
          }
        } else if (property.value) {
          renderInline(property.value, value);
        } else {
          value.dataset.empty = "";
          value.textContent = "Empty";
        }
        row.append(key, value);
        wrap.append(row);
      }
      // Clicks on a row edit it; the head handles its own.
      editOnClick(wrap, view, (target) => Number(target.closest<HTMLElement>("[data-offset]")?.dataset.offset ?? 4));
    }
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const lines = (from: number, to: number) => ({ from: doc.lineAt(from).from, to: doc.lineAt(to).to });

  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    switch (node.name) {
      case "Table": {
        if (revealed(state, node.from, node.to)) break;
        const { from, to } = lines(node.from, node.to);
        const source = doc.sliceString(from, to);
        if (!parseTable(source)) break;
        out.push(Decoration.replace({ widget: new TableWidget(source), block: true }).range(from, to));
        break;
      }

      case "FencedCode": {
        const info = node.getChild("CodeInfo");
        if (!info || doc.sliceString(info.from, info.to).trim().toLowerCase() !== "mermaid") break;
        if (revealed(state, node.from, node.to)) break;
        const text = node.getChild("CodeText");
        const source = text ? doc.sliceString(text.from, text.to) : "";
        const { from, to } = lines(node.from, node.to);
        out.push(Decoration.replace({ widget: new MermaidWidget(source, isDark()), block: true }).range(from, to));
        break;
      }

      case "Frontmatter": {
        if (revealed(state, node.from, node.to)) break;
        const { from, to } = lines(node.from, node.to);
        const widget = new PropertiesWidget(doc.sliceString(from, to), isFolded(state, from, false));
        out.push(Decoration.replace({ widget, block: true }).range(from, to));
        break;
      }

      case "Blockquote": {
        const first = doc.lineAt(node.from);
        const head = parseCalloutHead(first.text);
        if (!head?.fold || !isFolded(state, node.from, head.fold === "-")) break;
        const last = doc.lineAt(node.to);
        if (last.number === first.number || revealed(state, node.from, node.to)) break;
        out.push(Decoration.replace({}).range(first.to, last.to));
        break;
      }
    }
  }
  return Decoration.set(out, true);
}

const blocks = StateField.define<DecorationSet>({
  create: build,
  update(value, tr) {
    const rebuild =
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setFocused) || e.is(toggleFold) || e.is(refreshPreview)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState);
    return rebuild ? build(tr.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const blockPreview = [
  focused,
  flipped,
  blocks,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
];
