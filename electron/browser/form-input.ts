/** What the listener reads off an event: the DOM's, or a test's stand-in. */
type InputLike = { isTrusted: boolean; composedPath(): unknown[] };
type Target = {
  addEventListener(type: "input", listener: (event: InputLike) => void, capture: boolean): void;
  removeEventListener(type: "input", listener: (event: InputLike) => void, capture: boolean): void;
};

const FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** A form control or editable text, looked for past shadow roots, which retarget the event. */
function isField(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const { tagName, isContentEditable } = node as { tagName?: unknown; isContentEditable?: unknown };
  return isContentEditable === true || (typeof tagName === "string" && FIELDS.has(tagName.toUpperCase()));
}

/**
 * Calls `report` the first time the person types into a form field of this
 * document, then stops listening: one message per document, never one per
 * keystroke. Runs in the preload's isolated world, where the page can't reach
 * `report`. A page's own dispatched events are untrusted, and `execCommand`
 * fires trusted ones, so a real user gesture must be in effect as well.
 */
export function watchFormInput(target: Target, activated: () => boolean, report: () => void): void {
  const listener = (event: InputLike) => {
    if (!event.isTrusted || !activated() || !isField(event.composedPath()[0])) return;
    target.removeEventListener("input", listener, true);
    report();
  };
  target.addEventListener("input", listener, true);
}
