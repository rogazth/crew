import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  deleteColumn,
  deleteRow,
  duplicateRow,
  emptyGrid,
  escapeCell,
  formatTable,
  gridOf,
  gridSource,
  insertColumn,
  insertRow,
  moveColumn,
  moveInTable,
  moveRow,
  parsePastedGrid,
  parseTable,
  pasteGrid,
  setAlign,
  sortRows,
  splitRow,
  type Grid,
} from "./table";

describe("splitRow", () => {
  it("splits on unescaped pipes, outer pipes optional", () => {
    expect(splitRow("| a | b\\|c |").map((c) => c.text)).toEqual(["a", "b\\|c"]);
    expect(splitRow("a | b").map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("keeps each cell's source offsets", () => {
    const line = "| one | two |";
    for (const cell of splitRow(line)) expect(line.slice(cell.from, cell.to)).toBe(cell.text);
  });
});

describe("parseTable", () => {
  it("reads the header, alignment and rows", () => {
    const table = parseTable("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |")!;
    expect(table.header.map((c) => c.text)).toEqual(["a", "b", "c"]);
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.rows.map((r) => r.map((c) => c.text))).toEqual([["1", "2", "3"]]);
  });

  it("gives offsets into the whole source", () => {
    const source = "| a | b |\n|---|---|\n| xy | z |";
    const cell = parseTable(source)!.rows[0]![0]!;
    expect(source.slice(cell.from, cell.to)).toBe("xy");
  });

  it("needs a delimiter row", () => {
    expect(parseTable("| a |\n| b |")).toBeNull();
  });
});

describe("formatTable", () => {
  it("pads every column to its widest cell", () => {
    expect(formatTable("|a|long header|\n|-|:-:|\n|wide cell|x|")).toBe(
      ["| a         | long header |", "| --------- | :---------: |", "| wide cell |      x      |"].join("\n"),
    );
  });

  it("fills short rows", () => {
    expect(formatTable("| a | b |\n|---|---|\n| 1 |")).toBe("| a   | b   |\n| --- | --- |\n| 1   |     |");
  });
});

describe("moveInTable", () => {
  function run(doc: string, caret: number, move: "next" | "prev" | "down") {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) });
    const spec = moveInTable(state, move);
    if (!spec) return null;
    const next = state.update(spec).state;
    const head = next.selection.main.head;
    return next.doc.sliceString(0, head) + "|>" + next.doc.sliceString(head);
  }

  const doc = "| a | b |\n|---|---|\n| 1 | 2 |";

  it("formats and moves to the next cell", () => {
    expect(run(doc, 3, "next")).toBe("| a   | b|>   |\n| --- | --- |\n| 1   | 2   |");
  });

  it("wraps from the header to the first row", () => {
    expect(run(doc, 7, "next")).toBe("| a   | b   |\n| --- | --- |\n| 1|>   | 2   |");
  });

  it("adds a row past the last cell", () => {
    expect(run(doc, doc.length - 2, "next")).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| |>    |     |");
  });

  it("goes back to the previous row's last cell", () => {
    expect(run(doc, doc.indexOf("1"), "prev")).toBe("| a   | b|>   |\n| --- | --- |\n| 1   | 2   |");
  });

  it("moves down a row on Enter", () => {
    expect(run(doc, 3, "down")).toBe("| a   | b   |\n| --- | --- |\n| 1|>   | 2   |");
  });

  it("leaves the table on Enter in an empty last row", () => {
    const withEmpty = `${doc}\n|   |   |`;
    expect(run(withEmpty, withEmpty.length - 3, "down")).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n|>");
  });

  it("leaves text outside a table alone", () => {
    expect(run("just text", 2, "next")).toBeNull();
  });
});

describe("grid edits", () => {
  const grid = () => gridOf(parseTable("| name | n |\n|:--|--:|\n| b | 10 |\n| a | 9 |\n|  | 1 |")!);
  const rows = (g: Grid) => g.rows.map((r) => r.join(","));

  it("fills short rows to the widest", () => {
    expect(gridOf(parseTable("| a | b |\n|---|---|\n| 1 |")!).rows).toEqual([["1", ""]]);
  });

  it("serializes aligned, keeping alignment", () => {
    expect(gridSource(grid())).toBe(
      ["| name |   n |", "| :--- | --: |", "| b    |  10 |", "| a    |   9 |", "|      |   1 |"].join("\n"),
    );
  });

  it("adds, duplicates, moves and drops rows", () => {
    expect(rows(insertRow(grid(), 1))).toEqual(["b,10", ",", "a,9", ",1"]);
    expect(rows(duplicateRow(grid(), 0))).toEqual(["b,10", "b,10", "a,9", ",1"]);
    expect(rows(moveRow(grid(), 0, 2))).toEqual(["a,9", ",1", "b,10"]);
    expect(rows(deleteRow(grid(), 1))).toEqual(["b,10", ",1"]);
  });

  it("adds, moves and drops columns with their alignment", () => {
    const added = insertColumn(grid(), 1);
    expect(added.header).toEqual(["name", "", "n"]);
    expect(added.align).toEqual(["left", null, "right"]);
    const swapped = moveColumn(grid(), 1, 0);
    expect(swapped.header).toEqual(["n", "name"]);
    expect(swapped.align).toEqual(["right", "left"]);
    expect(rows(swapped)[0]).toBe("10,b");
    expect(deleteColumn(grid(), 0).header).toEqual(["n"]);
    expect(setAlign(grid(), 0, "center").align).toEqual(["center", "right"]);
  });

  it("sorts numbers by value and empty cells last", () => {
    expect(rows(sortRows(grid(), 1, "asc"))).toEqual([",1", "a,9", "b,10"]);
    expect(rows(sortRows(grid(), 0, "asc"))).toEqual(["a,9", "b,10", ",1"]);
    expect(rows(sortRows(grid(), 0, "desc"))).toEqual(["b,10", "a,9", ",1"]);
  });

  it("starts an empty table", () => {
    expect(gridSource(emptyGrid(2, 1))).toBe("|     |     |\n| --- | --- |\n|     |     |");
  });
});

describe("cell text", () => {
  it("escapes pipes once and joins lines", () => {
    expect(escapeCell("a | b \\| c\nd")).toBe("a \\| b \\| c d");
  });

  it("reads tab-separated paste as a grid", () => {
    expect(parsePastedGrid("a\tb\n1\t2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parsePastedGrid("just text")).toBeNull();
  });

  it("pastes over cells, growing the table", () => {
    const grid = gridOf(parseTable("| a | b |\n|---|---|\n| 1 | 2 |")!);
    const pasted = pasteGrid(grid, 1, 1, [["x", "y"], ["z", "w"]]);
    expect(pasted.header).toEqual(["a", "b", ""]);
    expect(pasted.rows).toEqual([["1", "x", "y"], ["", "z", "w"]]);
  });
});
