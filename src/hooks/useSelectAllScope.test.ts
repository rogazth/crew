// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { press } from "../test/dom";
import { renderHook } from "../test/renderHook";
import { useSelectAllScope } from "./useSelectAllScope";

function build() {
  document.body.innerHTML = `
    <main data-selectable><p id="line">first line</p><div contenteditable="false" id="locked">locked</div></main>
    <aside data-selectable id="other">other pane</aside>
    <nav id="chrome">chrome</nav>
    <input id="field" />
    <textarea id="notes"></textarea>
    <div contenteditable id="editor">draft</div>
    <div contenteditable="true" id="rich">rich</div>
  `;
  return (id: string) => document.getElementById(id) as HTMLElement;
}

const selected = () => window.getSelection()?.toString() ?? "";
const ranges = () => window.getSelection()?.rangeCount ?? 0;

function selectText(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe("useSelectAllScope", () => {
  let hook: ReturnType<typeof renderHook<void>> | null;
  let byId: (id: string) => HTMLElement;

  beforeEach(() => {
    byId = build();
    window.getSelection()?.removeAllRanges();
    hook = renderHook(() => useSelectAllScope());
  });

  afterEach(() => {
    hook?.unmount();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("selects the region under the cursor on Cmd+A", () => {
    expect(press(byId("line"), "a", { metaKey: true })).toBe(true);
    expect(selected()).toBe("first linelocked");
  });

  it("selects the region on Ctrl+A and with Shift held", () => {
    expect(press(byId("other"), "a", { ctrlKey: true })).toBe(true);
    expect(selected()).toBe("other pane");
    window.getSelection()?.removeAllRanges();
    expect(press(byId("other"), "A", { metaKey: true, shiftKey: true })).toBe(true);
    expect(selected()).toBe("other pane");
  });

  it("captures a read-only contenteditable inside a region", () => {
    expect(press(byId("locked"), "a", { metaKey: true })).toBe(true);
    expect(selected()).toBe("first linelocked");
  });

  it.each(["field", "notes", "editor", "rich"])("leaves select-all to the editable #%s", (id) => {
    expect(press(byId(id), "a", { metaKey: true })).toBe(false);
  });

  it.each([
    ["a plain A", "a", {}],
    ["Alt with Cmd", "a", { metaKey: true, altKey: true }],
    ["another key", "c", { metaKey: true }],
  ])("lets %s through", (_, key, init) => {
    selectText(byId("line"));
    expect(press(byId("line"), key, init)).toBe(false);
    expect(selected()).toBe("first line");
  });

  it("clears the selection instead of selecting the window outside any region", () => {
    selectText(byId("chrome"));
    expect(press(byId("chrome"), "a", { metaKey: true })).toBe(true);
    expect(ranges()).toBe(0);
  });

  it("selects nothing outside any region when nothing was selected", () => {
    expect(press(byId("chrome"), "a", { metaKey: true })).toBe(true);
    expect(ranges()).toBe(0);
  });

  it("falls back to the region holding the selection when the target is outside one", () => {
    selectText(byId("other").firstChild as Node);
    expect(press(document.body, "a", { metaKey: true })).toBe(true);
    expect(selected()).toBe("other pane");
  });

  it("falls back to a region anchored on an element", () => {
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.collapse(byId("other"), 0);
    expect(press(document, "a", { metaKey: true })).toBe(true);
    expect(selected()).toBe("other pane");
  });

  it("still swallows the shortcut when there is no selection object", () => {
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    expect(press(byId("line"), "a", { metaKey: true })).toBe(true);
  });

  it("stops scoping select-all once unmounted", () => {
    hook?.unmount();
    hook = null;
    expect(press(byId("line"), "a", { metaKey: true })).toBe(false);
  });
});
