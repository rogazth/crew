import { useEffect } from "react";

const EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false'])";

function regionFor(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    const hit = target.closest<HTMLElement>("[data-selectable]");
    if (hit) return hit;
  }
  const anchor = window.getSelection()?.anchorNode ?? null;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  return element?.closest<HTMLElement>("[data-selectable]") ?? null;
}

/** Cmd/Ctrl+A selects the content region under the cursor, never the whole window. */
export function useSelectAllScope() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "a" && event.key !== "A") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.target instanceof Element && event.target.closest(EDITABLE)) return;

      event.preventDefault();
      const selection = window.getSelection();
      if (!selection) return;
      // Read the region first: it may come from the selection this clears.
      const region = regionFor(event.target);
      selection.removeAllRanges();
      if (!region) return;
      const range = document.createRange();
      range.selectNodeContents(region);
      selection.addRange(range);
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
