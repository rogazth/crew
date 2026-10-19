import { useCallback, useEffect, useRef, useState } from "react";

type Overflow = { overflowing: boolean; canScrollStart: boolean; canScrollEnd: boolean };

const NONE: Overflow = { overflowing: false, canScrollStart: false, canScrollEnd: false };

/**
 * Horizontal overflow state for a tab strip, in the manner of a browser's "many tabs"
 * behaviour (scroll affordances at both edges, one screenful per press).
 *
 * The end is not read from the scroll offset: a fractional tab width can leave the
 * last stop a pixel short of the maximum, and the arrow would stay over the plus.
 * It is a marker at the strip's end: once that is wholly in view, so is the plus.
 */
export function useTabOverflow(watch: string) {
  const ref = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<Overflow>(NONE);
  const endInView = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setState((prev) => next(el, prev, endInView.current));
    const resize = new ResizeObserver(check);
    resize.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    const end = endRef.current;
    const seen = end
      ? new IntersectionObserver(
          ([entry]) => {
            endInView.current = entry ? entry.intersectionRatio > 0.99 : true;
            check();
          },
          { root: el, threshold: [0, 1] },
        )
      : null;
    if (end) seen?.observe(end);
    check();
    return () => {
      resize.disconnect();
      seen?.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, []);

  // Opening or closing a tab changes the scroll width without resizing the strip.
  useEffect(() => {
    const el = ref.current;
    if (el) setState((prev) => next(el, prev, endInView.current));
  }, [watch]);

  const scroll = useCallback((direction: "start" | "end") => {
    const el = ref.current;
    if (!el) return;
    const distance = Math.max(80, Math.floor(el.clientWidth * 0.8));
    el.scrollBy({ left: direction === "start" ? -distance : distance, behavior: "smooth" });
  }, []);

  return { ref, endRef, ...state, scroll };
}

function next(el: HTMLElement, prev: Overflow, endInView: boolean): Overflow {
  const max = Math.max(0, el.scrollWidth - el.clientWidth);
  const left = Math.min(Math.max(0, el.scrollLeft), max);
  const value: Overflow = {
    overflowing: max > 1,
    canScrollStart: left > 1,
    canScrollEnd: max > 1 && !endInView,
  };
  return prev.overflowing === value.overflowing &&
    prev.canScrollStart === value.canScrollStart &&
    prev.canScrollEnd === value.canScrollEnd
    ? prev
    : value;
}
