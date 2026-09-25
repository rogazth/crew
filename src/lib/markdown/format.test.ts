import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { toggleMarker } from "./format";

function run(doc: string, anchor: number, head: number, marker: string) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  toggleMarker(marker)({ state, dispatch: (tr) => (state = tr.state) });
  const { from, to } = state.selection.main;
  return `${state.doc.sliceString(0, from)}[${state.doc.sliceString(from, to)}]${state.doc.sliceString(to)}`;
}

describe("toggleMarker", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(run("make it bold", 8, 12, "**")).toBe("make it **[bold]**");
  });

  it("unwraps a selection already inside markers", () => {
    expect(run("make it **bold**", 10, 14, "**")).toBe("make it [bold]");
  });

  it("unwraps a selection that includes its markers", () => {
    expect(run("make it **bold**", 8, 16, "**")).toBe("make it [bold]");
  });

  it("wraps the word at the caret", () => {
    expect(run("one two", 5, 5, "*")).toBe("one *t[]wo*");
  });
});
