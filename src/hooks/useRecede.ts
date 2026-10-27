import { useEffect, useRef, type RefObject } from "react";
import { Spring, frames, reducedMotion, type Tune } from "../lib/spring";

// ζ ≈ 1.05: quick off the mark, then easing in to rest with no overshoot.
const TUNE: Tune = { stiffness: 560, damping: 49.5 };

/**
 * Steps the element back while `receded`: smaller by `--recede-scale` and
 * moved left by `--recede-shift` (index.css), away from the pane that comes
 * in on the right, so it reads as going back in depth. On a spring: closing
 * mid-way turns back with the speed it had. At rest it carries no transform,
 * so nothing in it lays out against one.
 */
export function useRecede(ref: RefObject<HTMLElement | null>, receded: boolean) {
  // 0 at rest, 1 stepped back.
  const spring = useRef(new Spring(0));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = spring.current;
    s.to = receded ? 1 : 0;
    const style = getComputedStyle(el);
    const depth = 1 - (Number.parseFloat(style.getPropertyValue("--recede-scale")) || 0.95);
    const shift = Number.parseFloat(style.getPropertyValue("--recede-shift")) || 0;
    const paint = () => {
      el.style.transform = s.x === 0 ? "" : `translateX(${-shift * s.x}px) scale(${1 - depth * s.x})`;
    };
    if (reducedMotion()) {
      s.snap();
      return paint();
    }
    return frames((dt, stalled) => {
      s.step(dt, TUNE);
      if (stalled || s.settled(0.001)) s.snap();
      paint();
      return s.x !== s.to || s.v !== 0;
    });
  }, [ref, receded]);
}
