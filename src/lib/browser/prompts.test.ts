import { describe, expect, it, vi } from "vitest";
import type { PagePrompt } from "./bridge";
import { createPromptStore } from "./prompts";

const prompt = (id: string, webContentsId: number): PagePrompt => ({
  kind: "permission",
  id,
  webContentsId,
  origin: "https://a.com",
  permissions: ["camera"],
});

describe("the prompt store", () => {
  it("keeps each page's questions apart, oldest first", () => {
    const store = createPromptStore();
    store.add(prompt("a", 1));
    store.add(prompt("b", 2));
    store.add(prompt("c", 1));
    expect(store.forPage(1).map((p) => p.id)).toEqual(["a", "c"]);
    expect(store.forPage(2).map((p) => p.id)).toEqual(["b"]);
    expect(store.forPage(3)).toEqual([]);
    expect(store.forPage(null)).toEqual([]);
  });

  it("hands a page the same list until its own questions change", () => {
    const store = createPromptStore();
    store.add(prompt("a", 1));
    const first = store.forPage(1);
    store.add(prompt("b", 2));
    expect(store.forPage(1)).toBe(first);
    store.remove("a");
    expect(store.forPage(1)).toEqual([]);
    expect(store.forPage(1)).toBe(store.forPage(99));
  });

  it("ignores a repeat and an id it never had", () => {
    const store = createPromptStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.add(prompt("a", 1));
    store.add(prompt("a", 1));
    store.remove("missing");
    expect(store.forPage(1)).toHaveLength(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
