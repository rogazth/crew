import type { EditorState, TransactionSpec } from "@codemirror/state";

/**
 * GFM tables as rows of cells with their source offsets, and the Tab/Enter
 * editing Obsidian's Advanced Tables made standard: every move re-aligns the
 * pipes, so the source stays as readable as the rendered table.
 */

export type Align = "left" | "center" | "right" | null;
/** `from`/`to` bound the trimmed text, relative to the table's first character. */
export type Cell = { text: string; from: number; to: number };
export type Table = { header: Cell[]; align: Align[]; rows: Cell[][] };

const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/** A row's cells: split on pipes that are not escaped, outer pipes optional. */
export function splitRow(line: string, offset = 0): Cell[] {
  const bounds: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") bounds.push(i);
  }
  let start = 0;
  let end = line.length;
  const trimmedStart = line.length - line.trimStart().length;
  if (bounds[0] === trimmedStart) {
    start = bounds.shift()! + 1;
  }
  if (bounds.length && bounds[bounds.length - 1] === line.trimEnd().length - 1) {
    end = bounds.pop()!;
  }
  const cells: Cell[] = [];
  let from = start;
  for (const to of [...bounds, end]) {
    const raw = line.slice(from, to);
    const text = raw.trim();
    // An empty cell's caret spot is one space in, where typing would start.
    const lead = text ? raw.length - raw.trimStart().length : Math.min(1, raw.length);
    cells.push({ text, from: offset + from + lead, to: offset + from + lead + text.length });
    from = to + 1;
  }
  return cells;
}

function alignOf(cell: string): Align {
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

export function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL.test(c.text));
}

export function parseTable(source: string): Table | null {
  const lines = source.split("\n");
  if (lines.length < 2 || !isDelimiterRow(lines[1]!)) return null;
  let offset = 0;
  const rows: Cell[][] = [];
  let header: Cell[] = [];
  let align: Align[] = [];
  lines.forEach((line, i) => {
    if (i === 0) header = splitRow(line, offset);
    else if (i === 1) align = splitRow(line).map((c) => alignOf(c.text));
    else rows.push(splitRow(line, offset));
    offset += line.length + 1;
  });
  return { header, align, rows };
}

/** Display width: a CJK or emoji character takes two columns in a monospace font. */
function width(text: string): number {
  let w = 0;
  for (const ch of text) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return w;
}

function pad(text: string, size: number, align: Align): string {
  const room = size - width(text);
  if (room <= 0) return text;
  if (align === "right") return " ".repeat(room) + text;
  if (align === "center") {
    const left = Math.floor(room / 2);
    return " ".repeat(left) + text + " ".repeat(room - left);
  }
  return text + " ".repeat(room);
}

function delimiter(size: number, align: Align): string {
  const dashes = "-".repeat(Math.max(size - (align === "center" ? 2 : align ? 1 : 0), 1));
  if (align === "center") return `:${dashes}:`;
  if (align === "left") return `:${dashes}`;
  if (align === "right") return `${dashes}:`;
  return dashes;
}

/** The table with every column padded to its widest cell, outer pipes included. */
export function formatTable(source: string): string | null {
  const table = parseTable(source);
  if (!table) return null;
  const columns = Math.max(table.header.length, ...table.rows.map((r) => r.length));
  const grid = [table.header, ...table.rows].map((row) =>
    Array.from({ length: columns }, (_, i) => row[i]?.text ?? ""),
  );
  const align = Array.from({ length: columns }, (_, i) => table.align[i] ?? null);
  const sizes = align.map((_, i) => Math.max(3, ...grid.map((row) => width(row[i]!))));
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const [head, ...body] = grid;
  return [
    line(head!.map((c, i) => pad(c, sizes[i]!, align[i]!))),
    line(align.map((a, i) => delimiter(sizes[i]!, a))),
    ...body.map((row) => line(row.map((c, i) => pad(c, sizes[i]!, align[i]!)))),
  ].join("\n");
}

type Located = { from: number; to: number; source: string; line: number; column: number };

/**
 * The table around the caret, found by its lines rather than the syntax tree:
 * a table the user is halfway through typing is still one to them.
 */
export function tableAt(state: EditorState, pos: number): Located | null {
  const doc = state.doc;
  const here = doc.lineAt(pos);
  if (!here.text.includes("|")) return null;
  let first = here.number;
  let last = here.number;
  while (first > 1 && doc.line(first - 1).text.includes("|") && doc.line(first - 1).text.trim()) first--;
  while (last < doc.lines && doc.line(last + 1).text.includes("|") && doc.line(last + 1).text.trim()) last++;
  if (last - first < 1 || !isDelimiterRow(doc.line(first + 1).text)) return null;
  const from = doc.line(first).from;
  const to = doc.line(last).to;
  return { from, to, source: doc.sliceString(from, to), line: here.number - first, column: columnAt(here.text, pos - here.from) };
}

/** Which cell `at` falls in: the unescaped pipes before it, less the leading one. */
function columnAt(line: string, at: number): number {
  const lead = line.length - line.trimStart().length;
  let pipes = 0;
  for (let i = 0; i < at && i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|" && i !== lead) pipes++;
  }
  return Math.max(0, Math.min(pipes, splitRow(line).length - 1));
}

/** Where the caret lands for a cell of the formatted source: the end of its text. */
function cellEnd(source: string, line: number, column: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i]!.length + 1;
  const cells = splitRow(lines[line]!, offset);
  return cells[Math.min(column, cells.length - 1)]!.to;
}

function emptyRow(columns: number): string {
  return "|" + "  |".repeat(columns);
}

/**
 * Re-align the table and move `dir` cells (Tab / Shift-Tab), or one row down
 * (Enter). Walking off the end adds a row, as in a spreadsheet.
 */
export function moveInTable(state: EditorState, move: "next" | "prev" | "down"): TransactionSpec | null {
  const main = state.selection.main;
  if (!main.empty) return null;
  const table = tableAt(state, main.head);
  if (!table) return null;
  // Enter on an empty last row leaves the table, as it leaves an empty list item.
  const sourceLines = table.source.split("\n");
  if (move === "down" && table.line === sourceLines.length - 1 && table.line > 1) {
    if (splitRow(sourceLines[table.line]!).every((c) => !c.text)) {
      const kept = sourceLines.slice(0, -1).join("\n");
      const formatted = formatTable(kept) ?? kept;
      return {
        changes: { from: table.from, to: table.to, insert: `${formatted}\n\n` },
        selection: { anchor: table.from + formatted.length + 2 },
        scrollIntoView: true,
        userEvent: "input",
      };
    }
  }
  let formatted = formatTable(table.source);
  if (!formatted) return null;
  const columns = splitRow(formatted.split("\n")[0]!).length;
  const rows = formatted.split("\n").length;
  let { line, column } = table;
  if (line === 1) line = 2; // the delimiter row is not a place to stop
  if (move === "next") {
    column++;
    if (column >= columns) {
      column = 0;
      line = line === 0 ? 2 : line + 1;
    }
  } else if (move === "prev") {
    column--;
    if (column < 0 && line === 0) column = 0;
    else if (column < 0) {
      line = line === 2 ? 0 : line - 1;
      column = columns - 1;
    }
  } else {
    line = line === 0 ? 2 : line + 1;
  }
  if (line >= rows) {
    formatted += "\n" + emptyRow(columns);
    formatted = formatTable(formatted) ?? formatted;
  }
  return {
    changes: { from: table.from, to: table.to, insert: formatted },
    selection: { anchor: table.from + cellEnd(formatted, line, column) },
    scrollIntoView: true,
    userEvent: "input",
  };
}
