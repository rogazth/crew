// What moves a settings dialog (SettingsDialog.tsx) in and out: one spring for the window, the notifications, the
// backdrop and the dialog together.
import { useLayoutEffect, useRef, useState } from "react";
import { Spring, frames, reducedMotion } from "../lib/spring";

/** How far the window sinks under it: a whisper, not a step back. */
const SINK = 0.008;
/**
 * Softer and a little under-damped (ζ ≈ 0.8): it eases in over about 300ms
 * with the faintest give at the end, and a close mid-way turns back with the
 * speed it had.
 */
const TUNE = { stiffness: 240, damping: 25 };

/**
 * Holds what the dialog shows through its way out: `target` is what the
 * caller has open (null once it lets go), `shown` stays until the spring has
 * landed shut. Painted before the browser paints, so the first frame is
 * already the spring's. The window (`[data-app]`) sinks under it, and the
 * notifications with it through `--dialog-sink` (index.css).
 */
export function useSettingsDialog<T>(target: T | null) {
  const [shown, setShown] = useState<T | null>(target);
  if (target !== null && target !== shown) setShown(target);
  const open = target !== null;
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const spring = useRef(new Spring(0));

  useLayoutEffect(() => {
    const app = document.querySelector<HTMLElement>("[data-app]");
    const s = spring.current;
    s.to = open ? 1 : 0;
    const paint = () => {
      // The opacities clamp; the transforms take the spring's give as it is.
      const x = Math.min(1, Math.max(0, s.x));
      const moving = s.x !== s.to || s.v !== 0;
      if (app) {
        app.style.transform = x === 0 ? "" : `scale(${1 - SINK * s.x})`;
        app.style.transformOrigin = x === 0 ? "" : "50% 50%";
        // On its own layer while it moves, so the frames composite instead of repainting the window; dropped at rest so the text re-rasters sharp.
        app.style.willChange = moving ? "transform" : "";
      }
      // The notifications are portaled out of the window: through a variable, so one that arrives
      // while the dialog is up sinks too, about the window's centre, under the backdrop.
      const root = document.documentElement;
      if (x === 0) {
        root.style.removeProperty("--dialog-sink");
        delete root.dataset.dialogSunk;
      } else {
        root.style.setProperty("--dialog-sink", String(1 - SINK * s.x));
        root.dataset.dialogSunk = "";
      }
      if (backdrop.current) backdrop.current.style.opacity = String(x);
      if (panel.current) {
        panel.current.style.opacity = String(x);
        panel.current.style.transform = `translateY(${(1 - s.x) * 8}px) scale(${0.98 + 0.02 * s.x})`;
      }
    };
    const land = () => {
      if (!open) setShown(null);
    };
    if (reducedMotion()) {
      s.snap();
      paint();
      return land();
    }
    paint();
    return frames((dt, stalled) => {
      s.step(dt, TUNE);
      const done = stalled || s.settled(0.001);
      if (done) s.snap();
      paint();
      if (done) land();
      return !done;
    });
  }, [open, shown]);

  return { shown, leaving: !open, backdrop, panel };
}
