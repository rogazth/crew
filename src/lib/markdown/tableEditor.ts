import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { Annotation, EditorState, Facet, Prec, type Extension } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { EditorView, WidgetType, drawSelection, keymap, type Command, type KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { IS_MAC } from "../hotkey";
import { SEPARATOR, type MenuAction, type MenuEntry, type MenuPoint } from "../menu";
import { renderInline } from "./inline";
import { followRendered } from "./links";
import {
  deleteColumn,
  deleteRow,
  duplicateRow,
  emptyGrid,
  escapeCell,
  gridOf,
  gridSource,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parsePastedGrid,
  parseTable,
  pasteGrid,
  setAlign,
  sortRows,
  type Align,
  type Grid,
} from "./table";

/**
 * A table that stays a table while it is edited: each cell opens a small
 * editor of its own text, and grips on the rows and columns move, sort, add
 * and drop them. Every edit is a change to the markdown, so the note's undo
 * history covers all of it. The source itself is one menu item away.
 */

export type TableMenu = { point: MenuPoint; actions: MenuEntry[]; onPick: (id: string) => void };

export type TableHost = {
  /** Shows a menu of table actions at a point. */
  menu: (menu: TableMenu) => void;
  /** What a cell's editor reads markdown with: language, highlighting, formatting keys. */
  cellExtensions: Extension;
};

export const tableHost = Facet.define<TableHost, TableHost>({
  combine: (values) => values[0] ?? { menu: () => undefined, cellExtensions: [] },
});

/** A change the table made to a cell's editor, which is not the user's typing. */
const fromTable = Annotation.define<boolean>();

/** Row 0 is the header; body rows follow from 1. */
type Spot = { row: number; col: number };
type Place = "start" | "end" | { x: number; y: number };

const views = new WeakMap<HTMLElement, TableView>();

/** The table that starts at `from`, as its whole lines. */
function tableRange(state: EditorState, from: number): { from: number; to: number } | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (node.name !== "Table") continue;
    return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to };
  }
  return null;
}

/** The rendered tables on screen. */
function renderedTables(view: EditorView): TableView[] {
  const out: TableView[] = [];
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".cm-md-table-wrap")) {
    const table = views.get(el);
    if (table) out.push(table);
  }
  return out;
}

function tableViewAt(view: EditorView, pos: number): TableView | null {
  for (const table of renderedTables(view)) {
    const range = table.range();
    if (range && pos >= range.from && pos <= range.to) return table;
  }
  return null;
}

const action = (id: string, label: string, icon: MenuAction["icon"], hotkey = "", extra: Partial<MenuAction> = {}): MenuAction => ({
  id,
  label,
  icon,
  hotkey,
  ...extra,
});
const DELETE_KEY = IS_MAC ? "⌘⌫" : "Del";

class TableView {
  readonly dom: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly drop: HTMLDivElement;
  private grid: Grid;
  private cells: HTMLTableCellElement[][] = [];
  /** `edited` once the user typed in it: only then does leaving it re-align the pipes. */
  private editing: { spot: Spot; editor: EditorView; edited: boolean } | null = null;
  private hot: Spot | null = null;

  constructor(
    private readonly view: EditorView,
    private source: string,
    readonly editable: boolean,
  ) {
    this.grid = gridOf(parseTable(source)!);
    this.dom = document.createElement("div");
    this.dom.className = "cm-md-table-wrap";
    // Outside the note's editing host, so a cell's editor is a host of its own and takes focus.
    this.dom.contentEditable = "false";
    const scroll = document.createElement("div");
    scroll.className = "cm-md-table-scroll";
    this.frame = document.createElement("div");
    this.frame.className = "cm-md-table-frame";
    this.drop = document.createElement("div");
    this.drop.className = "cm-md-table-drop";
    scroll.append(this.frame);
    this.dom.append(scroll);
    views.set(this.dom, this);
    if (editable) {
      this.dom.dataset.editable = "";
      this.dom.addEventListener("mousedown", (event) => this.onMouseDown(event));
      this.dom.addEventListener("contextmenu", (event) => this.onContextMenu(event));
      this.dom.addEventListener("pointerover", (event) => this.onHover(event));
      this.dom.addEventListener("pointerleave", () => this.setHot(null));
    } else {
      // Reading: links still open.
      this.dom.addEventListener("mousedown", (event) => {
        if (event.button === 0 && followRendered(event.target, view)) event.preventDefault();
      });
    }
    this.render();
  }

  get columns() {
    return this.grid.header.length;
  }

  /** Rows counting the header. */
  get rows() {
    return this.grid.rows.length + 1;
  }

  /** Where the table is in the note now, or null once it is gone. */
  range(): { from: number; to: number } | null {
    if (!this.dom.isConnected) return null;
    let from: number;
    try {
      from = this.view.posAtDOM(this.dom);
    } catch {
      return null;
    }
    return tableRange(this.view.state, from);
  }

  private text(spot: Spot): string {
    return (spot.row === 0 ? this.grid.header : this.grid.rows[spot.row - 1]!)[spot.col] ?? "";
  }

  /** New source from the note: cells patch in place while the shape holds. */
  update(source: string) {
    if (source === this.source) return;
    const table = parseTable(source);
    if (!table) return;
    const grid = gridOf(table);
    const sameShape = grid.header.length === this.columns && grid.rows.length + 1 === this.rows;
    this.source = source;
    const before = this.grid;
    this.grid = grid;
    if (!sameShape || grid.align.some((a, i) => a !== before.align[i])) {
      this.render();
      return;
    }
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.columns; col++) {
        const spot = { row, col };
        const text = this.text(spot);
        const old = (row === 0 ? before.header : before.rows[row - 1]!)[col];
        if (this.isEditing(spot)) this.syncEditor(text);
        else if (text !== old) this.fill(this.cells[row]![col]!, text);
      }
    }
  }

  private isEditing(spot: Spot) {
    return this.editing?.spot.row === spot.row && this.editing.spot.col === spot.col;
  }

  private syncEditor(text: string) {
    const editor = this.editing!.editor;
    const current = editor.state.doc.toString();
    // The source trims its cells: a space just typed at either end is still there to type on from.
    if (current.trim() === text) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: text }, annotations: fromTable.of(true) });
  }

  private fill(td: HTMLTableCellElement, text: string) {
    const content = document.createElement("div");
    content.className = "cm-md-cell";
    renderInline(text, content);
    // The grip stays; the text is what changes.
    const grips = [...td.querySelectorAll(":scope > .cm-md-grip")];
    td.replaceChildren(content, ...grips);
  }

  private render() {
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    const body = table.createTBody();
    this.cells = [];
    for (let row = 0; row < this.rows; row++) {
      const tr = row === 0 ? head : body.insertRow();
      const cells: HTMLTableCellElement[] = [];
      for (let col = 0; col < this.columns; col++) {
        const td = row === 0 ? document.createElement("th") : tr.insertCell();
        if (row === 0) tr.append(td);
        td.dataset.row = String(row);
        td.dataset.col = String(col);
        const align = this.grid.align[col];
        if (align) td.style.textAlign = align;
        this.fill(td, this.text({ row, col }));
        if (this.editable && row === 0) td.append(this.grip("col", col));
        if (this.editable && row > 0 && col === 0) td.append(this.grip("row", row));
        cells.push(td);
      }
      this.cells.push(cells);
    }
    const parts: HTMLElement[] = [table];
    if (this.editable) {
      parts.push(this.adder("row"), this.adder("col"), this.drop);
    }
    this.frame.replaceChildren(...parts);

    // An open editor moves into the cell that took its place, or closes with it gone.
    if (this.editing) {
      const { spot, editor } = this.editing;
      const td = this.cells[spot.row]?.[spot.col];
      if (td) {
        this.mountEditor(td, editor);
        editor.focus();
      } else {
        this.editing = null;
        editor.destroy();
      }
    }
    this.hot = null;
    this.view.requestMeasure();
  }

  private grip(kind: "row" | "col", index: number) {
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = `cm-md-grip cm-md-grip-${kind}`;
    grip.setAttribute("aria-label", kind === "row" ? "Row actions" : "Column actions");
    grip.tabIndex = -1;
    grip.addEventListener("pointerdown", (event) => this.onGripDown(event, kind, index));
    return grip;
  }

  private adder(kind: "row" | "col") {
    const add = document.createElement("button");
    add.type = "button";
    add.className = `cm-md-table-add cm-md-table-add-${kind}`;
    add.setAttribute("aria-label", kind === "row" ? "Add row" : "Add column");
    add.title = kind === "row" ? "Add row" : "Add column";
    add.tabIndex = -1;
    add.textContent = "+";
    add.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (kind === "row") this.apply(insertRow(this.grid, this.grid.rows.length), { row: this.rows, col: 0 });
      else this.apply(insertColumn(this.grid, this.columns), { row: 0, col: this.columns });
    });
    return add;
  }

  // Pointer

  private spotOf(target: EventTarget | null): Spot | null {
    const td = target instanceof Element ? target.closest<HTMLElement>("td, th") : null;
    if (!td || !this.dom.contains(td) || td.dataset.row === undefined) return null;
    return { row: Number(td.dataset.row), col: Number(td.dataset.col) };
  }

  private onMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".cm-md-grip, .cm-md-table-add")) return;
    // Inside the open editor, the editor handles its own clicks.
    if (this.editing && this.editing.editor.dom.contains(target)) return;
    if (followRendered(target, this.view)) {
      event.preventDefault();
      return;
    }
    const spot = this.spotOf(target);
    if (!spot) return;
    event.preventDefault();
    this.open(spot, { x: event.clientX, y: event.clientY });
  }

  private onContextMenu(event: MouseEvent) {
    const spot = this.spotOf(event.target);
    if (!spot) return;
    event.preventDefault();
    event.stopPropagation();
    // A body cell's menu is its row's, then its column's, which carries the one source item.
    const actions =
      spot.row === 0 ? this.columnActions(spot.col) : [...this.rowActions(spot.row, false), SEPARATOR, ...this.columnActions(spot.col, "")];
    this.menu({ x: event.clientX, y: event.clientY }, actions, (id) => this.run(id, spot));
  }

  private onHover(event: PointerEvent) {
    const spot = this.spotOf(event.target);
    if (spot) this.setHot(spot);
  }

  /** The grips of the row and column under the pointer show. */
  private setHot(spot: Spot | null) {
    if (this.hot) {
      this.cells[0]?.[this.hot.col]?.classList.remove("cm-md-hot-col");
      this.cells[this.hot.row]?.[0]?.classList.remove("cm-md-hot-row");
    }
    this.hot = spot;
    if (spot) {
      this.cells[0]?.[spot.col]?.classList.add("cm-md-hot-col");
      if (spot.row > 0) this.cells[spot.row]?.[0]?.classList.add("cm-md-hot-row");
    }
  }

  /** A click on a grip opens its menu; a drag moves its row or column. */
  private onGripDown(event: PointerEvent, kind: "row" | "col", index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let target = index;

    const edges = () => {
      if (kind === "col") return this.cells[0]!.map((td) => td.getBoundingClientRect());
      return this.cells.slice(1).map((row) => row[0]!.parentElement!.getBoundingClientRect());
    };
    // Slots are the gaps between rows (or columns), 0 before the first.
    const slotAt = (x: number, y: number) => {
      const rects = edges();
      let slot = 0;
      for (const rect of rects) {
        const middle = kind === "col" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
        if ((kind === "col" ? x : y) > middle) slot++;
      }
      return slot;
    };
    const showDrop = (slot: number) => {
      const rects = edges();
      const frame = this.frame.getBoundingClientRect();
      const table = this.frame.querySelector("table")!.getBoundingClientRect();
      const edge = slot < rects.length ? (kind === "col" ? rects[slot]!.left : rects[slot]!.top) : kind === "col" ? rects.at(-1)!.right : rects.at(-1)!.bottom;
      const style = this.drop.style;
      style.display = "block";
      if (kind === "col") {
        Object.assign(style, { left: `${edge - frame.left - 1}px`, top: `${table.top - frame.top}px`, width: "2px", height: `${table.height}px` });
      } else {
        Object.assign(style, { top: `${edge - frame.top - 1}px`, left: `${table.left - frame.left}px`, height: "2px", width: `${table.width}px` });
      }
    };

    const onMove = (move: PointerEvent) => {
      if (!dragging && Math.hypot(move.clientX - start.x, move.clientY - start.y) < 4) return;
      if (!dragging) {
        dragging = true;
        this.closeEditor(false);
        this.dom.dataset.dragging = kind;
      }
      const slot = slotAt(move.clientX, move.clientY);
      target = slot > index - (kind === "row" ? 1 : 0) ? slot - 1 : slot;
      showDrop(slot);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      this.drop.style.display = "";
      delete this.dom.dataset.dragging;
      if (!dragging) {
        const rect = grip.getBoundingClientRect();
        const point = { x: rect.left, y: rect.bottom + 4 };
        if (kind === "col") this.menu(point, this.columnActions(index), (id) => this.run(id, { row: 0, col: index }));
        else this.menu(point, this.rowActions(index), (id) => this.run(id, { row: index, col: 0 }));
        return;
      }
      if (kind === "col" && target !== index) this.apply(moveColumn(this.grid, index, target), null);
      // Rows count from the header in a spot, from the first body row in the grid.
      if (kind === "row" && target !== index - 1) this.apply(moveRow(this.grid, index - 1, target), null);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  }

  // Menus

  private menu(point: MenuPoint, actions: MenuEntry[], onPick: (id: string) => void) {
    this.view.state.facet(tableHost).menu({ point, actions, onPick });
  }

  private rowActions(row: number, source = true): MenuEntry[] {
    const body = this.grid.rows.length;
    return [
      action("row-above", "Insert Row Above", "row-above", "A"),
      action("row-below", "Insert Row Below", "row-below", "B"),
      action("row-duplicate", "Duplicate Row", "duplicate", "D"),
      SEPARATOR,
      action("row-up", "Move Row Up", "move-up", "", { disabled: row <= 1 }),
      action("row-down", "Move Row Down", "move-down", "", { disabled: row >= body }),
      SEPARATOR,
      ...(source ? [action("source", "Edit as Markdown", "code", "M")] : []),
      action("row-delete", "Delete Row", "delete", DELETE_KEY, { danger: true }),
    ];
  }

  /** `deleteKey` is "" beside a row's menu, whose delete takes the key. */
  private columnActions(col: number, deleteKey = DELETE_KEY): MenuEntry[] {
    const align = this.grid.align[col];
    return [
      action("col-left", "Insert Column Left", "column-left", "L"),
      action("col-right", "Insert Column Right", "column-right", "R"),
      SEPARATOR,
      action("col-move-left", "Move Column Left", "move-left", "", { disabled: col === 0 }),
      action("col-move-right", "Move Column Right", "move-right", "", { disabled: col === this.columns - 1 }),
      SEPARATOR,
      action("sort-asc", "Sort A to Z", "sort-asc", "S", { disabled: this.grid.rows.length < 2 }),
      action("sort-desc", "Sort Z to A", "sort-desc", "Z", { disabled: this.grid.rows.length < 2 }),
      SEPARATOR,
      action("align-left", "Align Left", "align-left", "", { checked: align === "left" }),
      action("align-center", "Align Center", "align-center", "", { checked: align === "center" }),
      action("align-right", "Align Right", "align-right", "", { checked: align === "right" }),
      SEPARATOR,
      action("source", "Edit as Markdown", "code", "M"),
      action("col-delete", "Delete Column", "delete", deleteKey, { danger: true, disabled: this.columns < 2 }),
    ];
  }

  private run(id: string, { row, col }: Spot) {
    const grid = this.grid;
    const body = row - 1;
    const alignTo = (a: Align) => setAlign(grid, col, grid.align[col] === a ? null : a);
    switch (id) {
      case "row-above": return this.apply(insertRow(grid, body), { row, col: 0 });
      case "row-below": return this.apply(insertRow(grid, body + 1), { row: row + 1, col: 0 });
      case "row-duplicate": return this.apply(duplicateRow(grid, body), null);
      case "row-up": return this.apply(moveRow(grid, body, body - 1), null);
      case "row-down": return this.apply(moveRow(grid, body, body + 1), null);
      case "row-delete": return this.apply(deleteRow(grid, body), null);
      case "col-left": return this.apply(insertColumn(grid, col), { row: 0, col });
      case "col-right": return this.apply(insertColumn(grid, col + 1), { row: 0, col: col + 1 });
      case "col-move-left": return this.apply(moveColumn(grid, col, col - 1), null);
      case "col-move-right": return this.apply(moveColumn(grid, col, col + 1), null);
      case "col-delete": return this.apply(deleteColumn(grid, col), null);
      case "sort-asc": return this.apply(sortRows(grid, col, "asc"), null);
      case "sort-desc": return this.apply(sortRows(grid, col, "desc"), null);
      case "align-left": return this.apply(alignTo("left"), null);
      case "align-center": return this.apply(alignTo("center"), null);
      case "align-right": return this.apply(alignTo("right"), null);
      case "source": return this.editSource();
    }
  }

  // Writing to the note

  /** The table rewritten from a grid, then a cell opened in it. */
  private apply(grid: Grid, open: Spot | null) {
    this.closeEditor(false);
    const range = this.range();
    if (!range) return;
    const view = this.view;
    view.dispatch({ changes: { from: range.from, to: range.to, insert: gridSource(grid) }, userEvent: "input" });
    // The dispatch may have rebuilt the widget; find whichever stands at the same place.
    if (open) tableViewAt(view, range.from)?.open(open, "end");
  }

  /** The cell's text written into the note as the smallest change. */
  private write(spot: Spot, text: string) {
    const range = this.range();
    if (!range) return;
    const source = this.view.state.sliceDoc(range.from, range.to);
    const table = parseTable(source);
    if (!table) return;
    const cell = (spot.row === 0 ? table.header : table.rows[spot.row - 1])?.[spot.col];
    if (!cell) {
      // A short row has no such cell in its source: write the row out whole.
      const grid = gridOf(table);
      (spot.row === 0 ? grid.header : grid.rows[spot.row - 1]!)[spot.col] = text;
      this.view.dispatch({ changes: { from: range.from, to: range.to, insert: gridSource(grid) }, userEvent: "input.type" });
      return;
    }
    const old = cell.text;
    let start = 0;
    while (start < old.length && start < text.length && old[start] === text[start]) start++;
    let end = 0;
    while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
    this.view.dispatch({
      changes: { from: range.from + cell.from + start, to: range.from + cell.to - end, insert: text.slice(start, text.length - end) },
      userEvent: "input.type",
    });
  }

  /** Pipes padded back into line, as they are whenever a cell is left. */
  private format() {
    const range = this.range();
    if (!range) return;
    const source = this.view.state.sliceDoc(range.from, range.to);
    const table = parseTable(source);
    if (!table) return;
    const formatted = gridSource(gridOf(table));
    if (formatted !== source) this.view.dispatch({ changes: { from: range.from, to: range.to, insert: formatted }, userEvent: "input" });
  }

  private editSource() {
    this.closeEditor(false);
    const range = this.range();
    if (!range) return;
    this.view.focus();
    this.view.dispatch({ selection: { anchor: this.view.state.doc.lineAt(range.from).to } });
  }

  // The cell editor

  open(spot: Spot, place: Place) {
    if (!this.editable) return;
    const td = this.cells[spot.row]?.[spot.col];
    if (!td) return;
    if (this.editing && !this.isEditing(spot)) {
      const from = this.range()?.from;
      this.closeEditor(true);
      // Formatting may have rebuilt the widget: the cell opens in whichever stands here now.
      const self = from === undefined ? null : tableViewAt(this.view, from);
      if (self && self !== this) {
        self.open(spot, place);
        return;
      }
    }
    let editor = this.editing?.editor;
    if (!editor) {
      editor = this.createEditor(spot);
      this.editing = { spot, editor, edited: false };
      this.mountEditor(this.cells[spot.row]![spot.col]!, editor);
    }
    editor.focus();
    const length = editor.state.doc.length;
    const at = place === "start" ? 0 : place === "end" ? length : (editor.posAtCoords(place) ?? length);
    editor.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    this.cells[spot.row]![spot.col]!.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private mountEditor(td: HTMLTableCellElement, editor: EditorView) {
    const content = document.createElement("div");
    content.className = "cm-md-cell cm-md-cell-editing";
    content.append(editor.dom);
    const grips = [...td.querySelectorAll(":scope > .cm-md-grip")];
    td.replaceChildren(content, ...grips);
    td.classList.add("cm-md-editing");
  }

  /** Closes the cell editor; `format` re-aligns the pipes of an edited cell, which writes to the note. */
  closeEditor(format: boolean) {
    const editing = this.editing;
    if (!editing) return;
    format &&= editing.edited;
    this.editing = null;
    const td = this.cells[editing.spot.row]?.[editing.spot.col];
    editing.editor.destroy();
    if (td) {
      td.classList.remove("cm-md-editing");
      this.fill(td, this.text(editing.spot));
    }
    if (format) this.format();
  }

  /** Leaves the table for the line above or below it, making one if there is none. */
  private leave(dir: -1 | 1) {
    this.closeEditor(true);
    const range = this.range();
    if (!range) return;
    const view = this.view;
    const doc = view.state.doc;
    view.focus();
    if (dir < 0) {
      if (range.from > 0) view.dispatch({ selection: { anchor: range.from - 1 }, scrollIntoView: true });
      else view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 }, scrollIntoView: true });
    } else if (range.to < doc.length) {
      view.dispatch({ selection: { anchor: range.to + 1 }, scrollIntoView: true });
    } else {
      view.dispatch({ changes: { from: range.to, insert: "\n" }, selection: { anchor: range.to + 1 }, scrollIntoView: true });
    }
  }

  /** Tab order: along the row, then down; past the last cell adds a row. */
  private step(delta: 1 | -1) {
    const spot = this.editing!.spot;
    let index = spot.row * this.columns + spot.col + delta;
    if (index < 0) index = 0;
    if (index >= this.rows * this.columns) {
      this.apply(insertRow(this.grid, this.grid.rows.length), { row: this.rows, col: 0 });
      return;
    }
    this.open({ row: Math.floor(index / this.columns), col: index % this.columns }, "end");
  }

  private vertical(dir: 1 | -1, addPastEnd: boolean) {
    const spot = this.editing!.spot;
    const row = spot.row + dir;
    if (row < 0) return this.leave(-1);
    if (row >= this.rows) {
      if (addPastEnd) return this.apply(insertRow(this.grid, this.grid.rows.length), { row, col: spot.col });
      return this.leave(1);
    }
    this.open({ row, col: spot.col }, "end");
  }

  private pasteCells(cells: string[][]) {
    const spot = this.editing!.spot;
    this.apply(pasteGrid(this.grid, spot.row, spot.col, cells), null);
  }

  private createEditor(spot: Spot): EditorView {
    const host = this.view.state.facet(tableHost);
    const onLine = (view: EditorView, edge: "first" | "last") => {
      const head = view.state.selection.main.head;
      const here = view.coordsAtPos(head);
      const end = view.coordsAtPos(edge === "first" ? 0 : view.state.doc.length);
      return !here || !end || Math.abs(here.top - end.top) < 2;
    };
    const run = (fn: () => void): Command => () => {
      fn();
      return true;
    };
    const keys: KeyBinding[] = [
      { key: "Tab", run: run(() => this.step(1)), shift: run(() => this.step(-1)) },
      { key: "Enter", run: run(() => this.vertical(1, true)), shift: run(() => this.vertical(-1, false)) },
      { key: "Escape", run: run(() => this.leave(1)) },
      { key: "ArrowUp", run: (view) => onLine(view, "first") && (this.vertical(-1, false), true) },
      { key: "ArrowDown", run: (view) => onLine(view, "last") && (this.vertical(1, false), true) },
      {
        key: "ArrowLeft",
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty || sel.head > 0) return false;
          const at = this.editing!.spot;
          if (at.row === 0 && at.col === 0) this.leave(-1);
          else this.step(-1);
          return true;
        },
      },
      {
        key: "ArrowRight",
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty || sel.head < view.state.doc.length) return false;
          const at = this.editing!.spot;
          if (at.row === this.rows - 1 && at.col === this.columns - 1) {
            this.leave(1);
          } else {
            const index = at.row * this.columns + at.col + 1;
            this.open({ row: Math.floor(index / this.columns), col: index % this.columns }, "start");
          }
          return true;
        },
      },
      // One history for the note: undo in a cell undoes the note.
      { key: "Mod-z", run: run(() => undo(this.view)), preventDefault: true },
      { key: "Mod-Shift-z", run: run(() => redo(this.view)), preventDefault: true },
      { key: "Mod-y", run: run(() => redo(this.view)), preventDefault: true },
    ];
    let closing: ReturnType<typeof setTimeout> | undefined;
    const editor = new EditorView({
      state: EditorState.create({
        doc: this.text(spot),
        extensions: [
          Prec.highest(keymap.of(keys)),
          host.cellExtensions,
          drawSelection(),
          EditorView.lineWrapping,
          // A cell is one line of the row: a typed pipe is escaped, a line break never lands.
          EditorView.inputHandler.of((view, from, to, text) => {
            if (!text.includes("|")) return false;
            view.dispatch({ changes: { from, to, insert: escapeCell(text) }, selection: { anchor: from + escapeCell(text).length }, userEvent: "input.type" });
            return true;
          }),
          EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const text = event.clipboardData?.getData("text/plain");
              if (!text) return false;
              event.preventDefault();
              const cells = parsePastedGrid(text);
              if (cells && (cells.length > 1 || cells[0]!.length > 1)) {
                this.pasteCells(cells);
                return true;
              }
              view.dispatch(view.state.replaceSelection(escapeCell(text)), { userEvent: "input.paste" });
              return true;
            },
            blur: () => {
              // Leaving the window keeps the cell open; leaving the cell closes it.
              clearTimeout(closing);
              closing = setTimeout(() => {
                if (this.editing?.editor === editor && !editor.hasFocus && document.hasFocus()) this.closeEditor(true);
              }, 0);
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.every((tr) => tr.annotation(fromTable))) return;
            if (this.editing?.editor !== update.view) return;
            this.editing.edited = true;
            this.write(this.editing.spot, update.state.doc.toString());
          }),
        ],
      }),
    });
    return editor;
  }

  destroy() {
    if (this.editing) {
      this.editing.editor.destroy();
      this.editing = null;
    }
  }
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly editable: boolean,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.editable === this.editable;
  }
  get estimatedHeight() {
    return (this.source.split("\n").length - 1) * 33 + 16;
  }
  toDOM(view: EditorView) {
    return new TableView(view, this.source, this.editable).dom;
  }
  updateDOM(dom: HTMLElement) {
    const table = views.get(dom);
    if (!table || table.editable !== this.editable) return false;
    table.update(this.source);
    return true;
  }
  destroy(dom: HTMLElement) {
    views.get(dom)?.destroy();
  }
  ignoreEvent() {
    return true;
  }
}

/** The arrow keys step from the text into a rendered table's cells, which the caret would skip. */
function enter(dir: "up" | "down" | "left" | "right"): Command {
  return (view) => {
    const sel = view.state.selection.main;
    if (!sel.empty || !view.state.facet(EditorView.editable)) return false;
    const { doc } = view.state;
    const line = doc.lineAt(sel.head);
    const forward = dir === "down" || dir === "right";
    if (forward ? line.number === doc.lines : line.number === 1) return false;
    // Leaving the line: sideways from its end, or up and down from its first or last row.
    if (dir === "right" && sel.head !== line.to) return false;
    if (dir === "left" && sel.head !== line.from) return false;
    if ((dir === "up" || dir === "down") && doc.lineAt(view.moveVertically(sel, forward).head).number === line.number) return false;
    const table = tableViewAt(view, forward ? line.to + 1 : line.from - 1);
    if (!table) return false;
    if (forward) table.open({ row: 0, col: 0 }, "start");
    else table.open({ row: table.rows - 1, col: dir === "left" ? table.columns - 1 : 0 }, "end");
    return true;
  };
}

export const tableKeymap: KeyBinding[] = [
  { key: "ArrowDown", run: enter("down") },
  { key: "ArrowUp", run: enter("up") },
  { key: "ArrowRight", run: enter("right") },
  { key: "ArrowLeft", run: enter("left") },
];

/** A new empty table on its own lines below the caret's, its first cell open. */
export function insertTable(view: EditorView) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const source = gridSource(emptyGrid(3, 2));
  const blank = !line.text.trim();
  const from = blank ? line.from : line.to;
  const lead = blank ? "" : "\n\n";
  const start = from + lead.length;
  view.dispatch({
    changes: { from, to: blank ? line.to : from, insert: `${lead}${source}\n` },
    selection: { anchor: start + source.length + 1 },
    userEvent: "input",
    scrollIntoView: true,
  });
  tableViewAt(view, start)?.open({ row: 0, col: 0 }, "start");
}
