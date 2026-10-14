import { useEffect, useRef, useState, type RefObject } from "react";
import { registerDropTarget } from "../lib/dropTargets";

/** Registers a pane as a drop target and reports whether files hover it. */
export function useFileDrop(
  ref: RefObject<HTMLElement | null>,
  onDrop: (paths: string[]) => void,
  onUpload?: (files: File[]) => void,
): boolean {
  const [over, setOver] = useState(false);
  const latest = useRef({ onDrop, onUpload });
  useEffect(() => {
    latest.current = { onDrop, onUpload };
  });

  useEffect(
    () =>
      registerDropTarget({
        el: () => ref.current,
        onDrop: (paths) => latest.current.onDrop(paths),
        onUpload: (files) => {
          const take = latest.current.onUpload;
          take?.(files);
          return take !== undefined;
        },
        onOver: setOver,
      }),
    [ref],
  );

  return over;
}
