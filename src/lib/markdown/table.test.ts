import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { formatTable, moveInTable, parseTable, splitRow } from "./table";

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
