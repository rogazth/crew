import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Which rows of a fixed-height list are in view, give or take `overscan`: a
 * folder like node_modules opened in the explorer, or ten thousand search
 * results, paint only what the pane shows.
 */
export function useVirtualRows(ref: RefObject<HTMLElement | null>, count: number, rowHeight: number, overscan = 10) {
  const [view, setView] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight });
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    read();
    const resized = new ResizeObserver(read);
    resized.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref]);

  /** Scrolls the least that brings row `index` into view. */
  const scrollToIndex = useCallback(
    (index: number) => {
      const el = ref.current;
      if (!el) return;
      const top = index * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    },
    [ref, rowHeight],
  );

  const start = Math.max(0, Math.floor(view.top / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + overscan);
  return { start, end, total: count * rowHeight, scrollToIndex };
}
