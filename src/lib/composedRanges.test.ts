// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installComposedRangesShim } from "./composedRanges";

type ComposedRanges = (this: Selection, ...args: unknown[]) => unknown;
const proto = Selection.prototype as unknown as { getComposedRanges?: ComposedRanges };
const original = Object.getOwnPropertyDescriptor(Selection.prototype, "getComposedRanges");

/** WebKit's shape: shadow roots as rest arguments; a dictionary is a TypeError. */
function variadicOnly() {
  return vi.fn(function (this: Selection, ...args: unknown[]) {
    if (args.some((arg) => !(arg instanceof ShadowRoot))) throw new TypeError("Argument 1 is not a ShadowRoot");
    return [{ roots: args }];
  });
}

const shadowRoot = () => document.createElement("div").attachShadow({ mode: "open" });

afterEach(() => {
  if (original) Object.defineProperty(Selection.prototype, "getComposedRanges", original);
  else delete proto.getComposedRanges;
  vi.restoreAllMocks();
});

describe("installComposedRangesShim", () => {
  it("does nothing on an engine without getComposedRanges", () => {
    delete proto.getComposedRanges;
    installComposedRangesShim();
    expect(proto.getComposedRanges).toBeUndefined();
  });

  it("leaves an engine that already takes the dictionary form alone", () => {
    const native = vi.fn(() => []);
    proto.getComposedRanges = native;
    installComposedRangesShim();
    expect(proto.getComposedRanges).toBe(native);
    expect(native).toHaveBeenCalledWith({ shadowRoots: [] });
  });

  it("unwraps the dictionary form into shadow-root arguments on a variadic-only engine", () => {
    const native = variadicOnly();
    proto.getComposedRanges = native;
    installComposedRangesShim();
    const selection = document.getSelection()!;
    const [a, b] = [shadowRoot(), shadowRoot()];
    expect(proto.getComposedRanges).not.toBe(native);
    expect(selection.getComposedRanges({ shadowRoots: [a, b] })).toEqual([{ roots: [a, b] }]);
    expect(native).toHaveBeenLastCalledWith(a, b);
    expect(native.mock.contexts.at(-1)).toBe(selection);
  });

  it("treats a dictionary without shadowRoots as none", () => {
    const native = variadicOnly();
    proto.getComposedRanges = native;
    installComposedRangesShim();
    expect(document.getSelection()!.getComposedRanges({} as GetComposedRangesOptions)).toEqual([{ roots: [] }]);
    expect(native).toHaveBeenLastCalledWith();
  });

  it("passes the variadic form straight through", () => {
    const native = variadicOnly();
    proto.getComposedRanges = native;
    installComposedRangesShim();
    const call = proto.getComposedRanges!.bind(document.getSelection()!);
    const [a, b] = [shadowRoot(), shadowRoot()];
    expect(call(a)).toEqual([{ roots: [a] }]);
    expect(call(a, b)).toEqual([{ roots: [a, b] }]);
    expect(call()).toEqual([{ roots: [] }]);
    expect(() => call(null)).toThrow(TypeError);
  });

  it("does nothing before the document has a selection", () => {
    const native = variadicOnly();
    proto.getComposedRanges = native;
    vi.spyOn(document, "getSelection").mockReturnValue(null);
    installComposedRangesShim();
    expect(proto.getComposedRanges).toBe(native);
    expect(native).not.toHaveBeenCalled();
  });
});
