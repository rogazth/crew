// @vitest-environment happy-dom
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "../test/renderHook";
import { useTerminalSearch } from "./useTerminalSearch";

const LIGHT = {
  matchBackground: "#ffe9a8",
  matchOverviewRuler: "#ffe9a8",
  activeMatchBackground: "#ffc44d",
  activeMatchColorOverviewRuler: "#ffc44d",
  activeMatchBorder: "#8a6100",
};

const DARK = {
  matchBackground: "#5a4a12",
  matchOverviewRuler: "#5a4a12",
  activeMatchBackground: "#a97c19",
  activeMatchColorOverviewRuler: "#a97c19",
  activeMatchBorder: "#f0d089",
};

type Results = { resultIndex: number; resultCount: number };

/**
 * Stands in for xterm's search addon over a buffer with `count` matches. Like
 * the real one it wraps at either end and reports the active match after each find.
 */
function fakeAddon(count = 3) {
  let index = -1;
  const listeners = new Set<(results: Results) => void>();
  const report = () => listeners.forEach((listener) => listener({ resultIndex: index, resultCount: count }));
  const addon = {
    findNext: vi.fn((_query: string, options?: { incremental?: boolean }) => {
      if (!(options?.incremental && index >= 0)) index = (index + 1) % count;
      report();
      return true;
    }),
    findPrevious: vi.fn(() => {
      index = (index - 1 + count) % count;
      report();
      return true;
    }),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((listener: (results: Results) => void) => {
      listeners.add(listener);
      return { dispose: vi.fn(() => listeners.delete(listener)) };
    }),
    listening: () => listeners.size,
  };
  return addon;
}

function fakeTerminal(selection = "") {
  return { getSelection: vi.fn(() => selection), focus: vi.fn() };
}

// Stable, as the app's is: a new function each render would re-run the search each render.
const dark = () => true;
const light = () => false;

function setup({ selection = "", scheme = light, attached = true } = {}) {
  const terminal = fakeTerminal(selection);
  const term: { current: Terminal | null } = { current: terminal as unknown as Terminal };
  const addon = fakeAddon();
  const hook = renderHook(
    (props: { scheme: () => boolean }) => useTerminalSearch(term, props.scheme),
    { scheme },
  );
  let detach: (() => void) | undefined;
  if (attached) act(() => void (detach = hook.result.current.attach(addon as unknown as SearchAddon)));
  return { terminal, term, addon, hook, detach: () => act(() => detach?.()) };
}

describe("useTerminalSearch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts closed, empty and without results", () => {
    const { hook } = setup();
    expect(hook.result.current.open).toBeNull();
    expect(hook.result.current.query).toBe("");
    expect(hook.result.current.results).toEqual({ index: -1, count: 0 });
    hook.unmount();
  });

  it("opens with a fresh token each time it is started", () => {
    const { hook } = setup();
    act(() => hook.result.current.start());
    expect(hook.result.current.open).toEqual({ token: 1 });
    act(() => hook.result.current.start());
    expect(hook.result.current.open).toEqual({ token: 2 });
    hook.unmount();
  });

  it("seeds the query from a single-line selection, trimmed", () => {
    const { hook } = setup({ selection: "  needle \n" });
    act(() => hook.result.current.start());
    expect(hook.result.current.query).toBe("needle");
    hook.unmount();
  });

  it.each([
    ["a multi-line selection", "one\ntwo"],
    ["an empty selection", "   "],
  ])("keeps the typed query over %s", (_, selection) => {
    const { hook } = setup({ selection });
    act(() => hook.result.current.setQuery("typed"));
    act(() => hook.result.current.start());
    expect(hook.result.current.query).toBe("typed");
    hook.unmount();
  });

  it("opens without a terminal", () => {
    const { term, hook } = setup();
    term.current = null;
    act(() => hook.result.current.start());
    expect(hook.result.current.open).toEqual({ token: 1 });
    act(() => hook.result.current.close());
    expect(hook.result.current.open).toBeNull();
    hook.unmount();
  });

  it("searches as the query is typed into an open field, holding the current match", () => {
    const { addon, hook } = setup();
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    expect(addon.findNext).toHaveBeenLastCalledWith("err", { incremental: true, decorations: LIGHT });
    expect(hook.result.current.results).toEqual({ index: 0, count: 3 });
    act(() => hook.result.current.setQuery("erro"));
    expect(addon.findNext).toHaveBeenLastCalledWith("erro", { incremental: true, decorations: LIGHT });
    expect(hook.result.current.results).toEqual({ index: 0, count: 3 });
    hook.unmount();
  });

  it("paints matches in the dark palette on a dark terminal, and repaints when it changes", () => {
    const { addon, hook } = setup({ scheme: dark });
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    expect(addon.findNext).toHaveBeenLastCalledWith("err", { incremental: true, decorations: DARK });
    hook.rerender({ scheme: light });
    expect(addon.findNext).toHaveBeenLastCalledWith("err", { incremental: true, decorations: LIGHT });
    hook.unmount();
  });

  it("does not search while closed, and clears what a query painted", () => {
    const { addon, hook } = setup();
    act(() => hook.result.current.setQuery("err"));
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.clearDecorations).toHaveBeenCalled();
    hook.unmount();
  });

  it("steps forward and back through the matches, wrapping at both ends", () => {
    const { addon, hook } = setup();
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    const seen = [];
    for (const delta of [1, 1, 1, -1, -1]) {
      act(() => hook.result.current.step(delta));
      seen.push(hook.result.current.results.index);
    }
    expect(seen).toEqual([1, 2, 0, 2, 1]);
    expect(addon.findNext).toHaveBeenLastCalledWith("err", { decorations: LIGHT });
    expect(addon.findPrevious).toHaveBeenLastCalledWith("err", { decorations: LIGHT });
    expect(addon.findNext).toHaveBeenCalledTimes(4);
    expect(addon.findPrevious).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("does not step without a query", () => {
    const { addon, hook } = setup();
    act(() => hook.result.current.start());
    act(() => hook.result.current.step(1));
    act(() => hook.result.current.step(-1));
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.findPrevious).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("clears the highlights when the query is emptied", () => {
    const { addon, hook } = setup();
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    addon.clearDecorations.mockClear();
    addon.findNext.mockClear();
    act(() => hook.result.current.setQuery(""));
    expect(addon.clearDecorations).toHaveBeenCalledTimes(1);
    expect(addon.findNext).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("closes by clearing the highlights and results and handing focus back to the terminal", () => {
    const { addon, terminal, hook } = setup();
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    addon.clearDecorations.mockClear();
    act(() => hook.result.current.close());
    expect(hook.result.current.open).toBeNull();
    expect(hook.result.current.results).toEqual({ index: -1, count: 0 });
    expect(hook.result.current.query).toBe("err");
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("reopens on the last query and finds it again", () => {
    const { addon, hook } = setup();
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    act(() => hook.result.current.close());
    addon.findNext.mockClear();
    act(() => hook.result.current.start());
    expect(addon.findNext).toHaveBeenCalledWith("err", { incremental: true, decorations: LIGHT });
    hook.unmount();
  });

  it("works without an addon until one attaches", () => {
    const { addon, hook, terminal } = setup({ attached: false });
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    act(() => hook.result.current.step(1));
    act(() => hook.result.current.close());
    expect(terminal.focus).toHaveBeenCalledTimes(1);
    expect(addon.findNext).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("detaches by dropping its result listener and the addon", () => {
    const { addon, hook, detach } = setup();
    expect(addon.listening()).toBe(1);
    detach();
    expect(addon.listening()).toBe(0);
    act(() => hook.result.current.start());
    act(() => hook.result.current.setQuery("err"));
    act(() => hook.result.current.step(1));
    act(() => hook.result.current.close());
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.clearDecorations).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("keeps its callbacks stable while the query is unchanged", () => {
    const { hook } = setup();
    const { attach, start, close, step, setQuery } = hook.result.current;
    act(() => start());
    expect(hook.result.current.attach).toBe(attach);
    expect(hook.result.current.start).toBe(start);
    expect(hook.result.current.close).toBe(close);
    expect(hook.result.current.setQuery).toBe(setQuery);
    expect(hook.result.current.step).toBe(step);
    act(() => setQuery("err"));
    expect(hook.result.current.step).not.toBe(step);
    hook.unmount();
  });
});
