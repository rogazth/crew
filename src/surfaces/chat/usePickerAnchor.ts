import { useLayoutEffect, useState, type RefObject } from "react";
import type { PromptHandle } from "./PromptEditor";

/**
 * Where a picker opens: under the `@`, `#` or `/` that opened it, in pixels from
 * the well's left edge. It is read once per trigger, so the picker stays put as
 * the query is typed after it; null while no picker is open.
 */
export function usePickerAnchor(
  field: RefObject<PromptHandle | null>,
  well: RefObject<HTMLElement | null>,
  start: number | null,
): number | null {
  const [placed, setPlaced] = useState<{ start: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (start === null) return;
    const measure = () => {
      const at = field.current?.coordsAt(start);
      const box = well.current?.getBoundingClientRect();
      if (at && box) setPlaced({ start, left: at.left - box.left });
    };
    // The editor draws the trigger in the same commit that opens the picker: measure once it has.
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [field, well, start]);
  return placed && placed.start === start ? placed.left : null;
}

/**
 * The picker's place in the well: from its trigger, less the row's inset so the
 * icon sits under it, and pulled back in where it would run past the right edge.
 */
export function pickerStyle(left: number | null | undefined) {
  return { left: `clamp(0px, ${Math.round((left ?? 0) - 12)}px, calc(100% - var(--picker-w)))` };
}
