// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../lib/commands";
import { mount, type Mounted } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { FileEditor } from "./FileEditor";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

type Item = { id: string; file: { name: string; contents: string; cacheKey: string } };

/** What the editor boundary last received, and a way to type into it. */
const view = vi.hoisted(() => ({
  items: [] as Item[],
  change: null as ((item: Item, file: { contents: string }) => void) | null,
}));

vi.mock("@pierre/diffs/edit", () => ({ Editor: class {} }));
vi.mock("@pierre/diffs/react", () => ({
  EditProvider: ({ children }: { children: unknown }) => children,
  CodeView: ({ items, onItemEditChange }: { items: Item[]; onItemEditChange: typeof view.change }) => {
    view.items = items;
    view.change = onItemEditChange;
    return null;
  },
}));

function edit(contents: string) {
  act(() => view.change?.(view.items[0]!, { contents }));
}

function save() {
  act(() => {
    runCommand("save-file");
  });
}

async function settle(fn: () => void) {
  await act(async () => fn());
}

let editor: Mounted | null = null;

async function open(path = "/w/src/a.ts", relative = "src/a.ts", text = "const a = 1;\n") {
  editor = mount(<FileEditor path={path} relative={relative} />);
  await settle(() => fake.take("read_text_file").resolve(text));
  return editor;
}

beforeEach(() => {
  fake.reset();
  view.items = [];
  view.change = null;
});

afterEach(() => {
  editor?.unmount();
  editor = null;
});

describe("FileEditor", () => {
  it("reads the file and hands it to the editor keyed by its path", async () => {
    await open();
    expect(fake.sent("read_text_file")).toEqual([{ path: "/w/src/a.ts" }]);
    expect(view.items).toEqual([
      expect.objectContaining({ id: "/w/src/a.ts", file: { name: "a.ts", contents: "const a = 1;\n", cacheKey: "/w/src/a.ts" } }),
    ]);
  });

  it("does not write when nothing changed", async () => {
    await open();
    save();
    expect(fake.sent("write_text_file")).toEqual([]);
  });

  it("writes the edited text once it differs from the file", async () => {
    await open();
    edit("const a = 2;\n");
    save();
    expect(fake.sent("write_text_file")).toEqual([{ path: "/w/src/a.ts", contents: "const a = 2;\n" }]);
  });

  it("is clean again after a save lands", async () => {
    await open();
    edit("const a = 2;\n");
    save();
    await settle(() => fake.take("write_text_file").resolve(undefined));
    save();
    expect(fake.sent("write_text_file")).toHaveLength(1);
  });

  it("does not start a second write while one is in flight", async () => {
    await open();
    edit("const a = 2;\n");
    save();
    save();
    expect(fake.sent("write_text_file")).toHaveLength(1);
  });

  it("an edit back to the saved text leaves nothing to save", async () => {
    await open();
    edit("const a = 2;\n");
    edit("const a = 1;\n");
    save();
    expect(fake.sent("write_text_file")).toEqual([]);
  });

  it("reports a failed write without closing the editor, and keeps the edit to save again", async () => {
    const mounted = await open();
    edit("const a = 2;\n");
    save();
    view.items = [];
    await settle(() => fake.take("write_text_file").reject(new Error("read-only file system")));
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain("read-only file system");
    expect(view.items.map((item) => item.id)).toEqual(["/w/src/a.ts"]);

    save();
    expect(fake.sent("write_text_file")).toEqual([
      { path: "/w/src/a.ts", contents: "const a = 2;\n" },
      { path: "/w/src/a.ts", contents: "const a = 2;\n" },
    ]);
  });

  it("clears the write error once a save lands", async () => {
    const mounted = await open();
    edit("const a = 2;\n");
    save();
    await settle(() => fake.take("write_text_file").reject(new Error("read-only file system")));
    save();
    await settle(() => fake.take("write_text_file").resolve(undefined));
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    save();
    expect(fake.sent("write_text_file")).toHaveLength(2);
  });

  it("reports a file it could not read", async () => {
    editor = mount(<FileEditor path="/w/missing.ts" relative="missing.ts" />);
    await settle(() => fake.take("read_text_file").reject(new Error("no such file")));
    expect(editor.container.textContent).toContain("no such file");
    expect(view.items).toEqual([]);
  });

  it("ignores a read that lands after the tab moved to another file", async () => {
    editor = mount(<FileEditor path="/w/a.ts" relative="a.ts" />);
    const stale = fake.take("read_text_file");
    editor.rerender(<FileEditor path="/w/b.ts" relative="b.ts" />);
    await settle(() => fake.take("read_text_file").resolve("b"));
    await settle(() => stale.resolve("a"));
    expect(view.items.map((item) => [item.id, item.file.contents])).toEqual([["/w/b.ts", "b"]]);
  });

  it("stops offering save once it unmounts", async () => {
    const mounted = await open();
    mounted.unmount();
    editor = null;
    expect(runCommand("save-file")).toBe(false);
  });
});
