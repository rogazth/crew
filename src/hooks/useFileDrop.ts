import { useEffect, useRef, useState, type RefObject } from "react";
import { registerDropTarget } from "../lib/dropTargets";

/** Registers a pane as a drop target and reports whether files hover it. */
export function useFileDrop(
  ref: RefObject<HTMLElement | null>,
  onDrop: (paths: string[]) => void,
): boolean {
  const [over, setOver] = useState(false);
  const latest = useRef(onDrop);
  useEffect(() => {
    latest.current = onDrop;
  });

  useEffect(
    () =>
      registerDropTarget({
        el: () => ref.current,
        onDrop: (paths) => latest.current(paths),
        onOver: setOver,
      }),
    [ref],
  );

  return over;
}
