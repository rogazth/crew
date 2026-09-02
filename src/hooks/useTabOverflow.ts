import { useCallback, useEffect, useRef, useState } from "react";

type Overflow = { overflowing: boolean; canScrollStart: boolean; canScrollEnd: boolean };

const NONE: Overflow = { overflowing: false, canScrollStart: false, canScrollEnd: false };

/**
 * Horizontal overflow state for a tab strip, following kumo's Tabs "many tabs"
 * behaviour (scroll affordances at both edges, one screenful per press).
 */
export function useTabOverflow(watch: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Overflow>(NONE);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setState((prev) => next(el, prev));
    const resize = new ResizeObserver(check);
    resize.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    check();
    return () => {
      resize.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, []);

  // Opening or closing a tab changes the scroll width without resizing the strip.
  useEffect(() => {
    const el = ref.current;
    if (el) setState((prev) => next(el, prev));
  }, [watch]);

  const scroll = useCallback((direction: "start" | "end") => {
    const el = ref.current;
    if (!el) return;
    const distance = Math.max(80, Math.floor(el.clientWidth * 0.8));
    el.scrollBy({ left: direction === "start" ? -distance : distance, behavior: "smooth" });
  }, []);

  return { ref, ...state, scroll };
}

function next(el: HTMLElement, prev: Overflow): Overflow {
  const max = Math.max(0, el.scrollWidth - el.clientWidth);
  const left = Math.min(Math.max(0, el.scrollLeft), max);
  const value: Overflow = {
    overflowing: max > 1,
    canScrollStart: left > 1,
    canScrollEnd: max - left > 1,
  };
  return prev.overflowing === value.overflowing &&
    prev.canScrollStart === value.canScrollStart &&
    prev.canScrollEnd === value.canScrollEnd
    ? prev
    : value;
}
