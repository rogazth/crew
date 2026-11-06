import { useLayoutEffect, useRef } from "react";
import { Spring, frames, reducedMotion, type Tune } from "../lib/spring";

// ζ ≈ 0.75: it gets there quick and settles with a touch of give.
const PILL_TUNE: Tune = { stiffness: 520, damping: 34 };

/**
 * The pill under a row of tabs, on the one marked `data-tab={value}`: the
 * first time it is just there, then it slides and stretches to the next on a
 * spring; picked again mid-way, it turns with the speed it had. No value hides
 * it where it stands. It measures on every render, so a label that changes
 * width moves it too; a pill mounted anew starts over. `inset` keeps it that
 * far in from each side of its tab.
 */
export function useSlidingPill<L extends HTMLElement>(value: string | null, inset = 0) {
  const list = useRef<L>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const x = useRef<Spring | null>(null);
  const w = useRef<Spring | null>(null);
  const mounted = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = pill.current;
    if (!el) return;
    if (mounted.current !== el) {
      mounted.current = el;
      x.current = null;
      w.current = null;
    }
    el.style.opacity = value === null ? "0" : "";
    const tab = value === null ? null : list.current?.querySelector<HTMLElement>(`[data-tab="${value}"]`);
    if (!tab) return;
    const paint = () => {
      el.style.transform = `translateX(${x.current!.x}px)`;
      el.style.width = `${w.current!.x}px`;
    };
    if (!x.current || !w.current) {
      x.current = new Spring(tab.offsetLeft + inset);
      w.current = new Spring(tab.offsetWidth - inset * 2);
      return paint();
    }
    const sx = x.current;
    const sw = w.current;
    sx.to = tab.offsetLeft + inset;
    sw.to = tab.offsetWidth - inset * 2;
    if (sx.x === sx.to && sw.x === sw.to) return;
    if (reducedMotion()) {
      sx.snap();
      sw.snap();
      return paint();
    }
    return frames((dt, stalled) => {
      sx.step(dt, PILL_TUNE);
      sw.step(dt, PILL_TUNE);
      if (stalled || (sx.settled(0.1) && sw.settled(0.1))) {
        sx.snap();
        sw.snap();
      }
      paint();
      return sx.x !== sx.to || sw.x !== sw.to;
    });
  });
  return { list, pill };
}
