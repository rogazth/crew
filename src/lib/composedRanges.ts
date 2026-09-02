/**
 * WebKit ships `Selection.getComposedRanges(...shadowRoots)`; @pierre/diffs calls the
 * older `getComposedRanges({ shadowRoots })` form. The TypeError lands inside the
 * editor's `selectionchange` handler, so the file editor renders but never gets a
 * caret and drops every keystroke. Adapt the argument shape when the dict form throws.
 */
export function installComposedRangesShim(): void {
  type ComposedRanges = (this: Selection, ...args: unknown[]) => StaticRange[];
  const proto = Selection.prototype as unknown as { getComposedRanges?: ComposedRanges };
  const native = proto.getComposedRanges;
  const selection = document.getSelection();
  if (typeof native !== "function" || selection === null) return;

  try {
    native.call(selection, { shadowRoots: [] });
    return;
  } catch {
    // Variadic-only engine: unwrap the dictionary below.
  }

  proto.getComposedRanges = function (...args: unknown[]) {
    const [first] = args;
    if (args.length === 1 && typeof first === "object" && first !== null && !(first instanceof ShadowRoot)) {
      const { shadowRoots } = first as { shadowRoots?: ShadowRoot[] };
      return native.apply(this, shadowRoots ?? []);
    }
    return native.apply(this, args);
  };
}
