// Collapsing the sidebar slides the main panel over it and the content
// widens to fill the window; that is the motion. The sidebar never moves
// left: hinged on its left edge it sinks back in z under the panel, its frame
// closing in on a card, and fades out at the end. Collapsed, it is gone. Springs drive it, interruptible and reversible (a
// new target keeps the velocity it had).
// Every frame writes inline styles on the few elements that move, never a
// custom property or an attribute up the tree, so no frame restyles the app.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Spring, reducedMotion, type Tune } from "../lib/spring";

// ζ ≈ 1.1: no overshoot, lands a touch quicker than critical.
const TUNE: Tune = { stiffness: 800, damping: 63 };

/** Collapsed, the content's left edge rests here: the sheet's own 8px gutter. */
const SNEAK = 8;
/** The card it closes in on, in the window: from just under the rail's strip, shorter than the sheet. */
const CARD = { left: 5, top: 42, bottom: 16, width: 48, radius: 10 };
/** Caught, the sidebar sinks into the window: hinged on its left edge (so it never moves
    left), it swings back and down in z under the panel. GPU-only: a 3D transform. */
const SINK = { perspective: 900, angle: 3, z: 8 };
/** The last stretch of the way down, over which it fades out: collapsed, it is gone. */
const FADE = 0.3;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

type Props = {
  open: boolean;
  width: number;
  sidebar: ReactNode;
  children: ReactNode;
};

/**
 * The sidebar under, the main panel over it. Two springs:
 *   x      where the content's left edge is laid out: the only thing that reflows
 *   depth  how far the sidebar is up: 1 open, 0 sunk and gone
 *  */
export function SlideShell({ open, width, sidebar, children }: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const under = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);

  const x = useRef(new Spring(open ? width : SNEAK));
  const depth = useRef(new Spring(open ? 1 : 0));
  const run = useRef({
    open,
    sb: width,
    raf: 0,
    last: 0,
    /** The strip's traffic-light reserve and workspace button, measured when a motion starts. */
    insetFull: 0,
    laidOut: Number.NaN,
    /** The shell's height, for the card's bottom; kept by a ResizeObserver. */
    height: 0,
  });

  const inset = () => content.current?.querySelector<HTMLElement>("[data-tab-inset]") ?? null;

  function apply() {
    const r = run.current;
    if (!main.current || !content.current || !under.current) return;
    const at = x.current.x;
    main.current.style.transform = `translate3d(${at}px,0,0)`;

    // The one thing that lays out: whole pixels, and only when they change.
    const laidOut = Math.round(at);
    if (laidOut !== r.laidOut) {
      r.laidOut = laidOut;
      content.current.style.width = `calc(100% - ${laidOut}px)`;
      // The tabs stay clear of the traffic lights: the reserve is whatever of it the panel no longer covers.
      const strip = inset();
      if (strip) strip.style.width = laidOut >= r.sb - 0.5 ? "0px" : `${Math.max(0, r.insetFull - laidOut)}px`;
    }

    // The sidebar sinks in z, its left edge where it is, as its frame closes in on the card.
    const caught = 1 - clamp01(depth.current.x);
    under.current.style.opacity = String(clamp01((1 - caught) / FADE));
    if (caught < 0.001) {
      under.current.style.transform = "";
      under.current.style.clipPath = "";
    } else {
      const angle = (SINK.angle * caught * Math.PI) / 180;
      const z = SINK.z * caught;
      const P = SINK.perspective;
      // Swung on the hinge first, then pushed back: the hinge stays on the window's edge.
      under.current.style.transform = `perspective(${P}px) translateZ(${-z}px) rotateY(${SINK.angle * caught}deg)`;
      // The card is fixed in the window; the clip is in the sidebar's own, sunk, space. Solve for the
      // local x that lands on the card's left, then the local y at that x (the perspective there).
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      const X = CARD.left;
      const localLeft = (X * (P + z)) / (c * P - X * sn);
      const depthAt = -localLeft * sn - z;
      const mid = r.height / 2;
      const localY = (Y: number) => mid + ((Y - mid) * (P - depthAt)) / P;
      const top = caught * localY(CARD.top);
      const bottom = caught * (r.height - localY(r.height - CARD.bottom));
      const left = caught * Math.max(0, localLeft);
      const right = caught * Math.max(0, r.sb - (localLeft + CARD.width));
      const radius = caught * CARD.radius;
      under.current.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
    }
  }

  /** Whatever is not on screen or not reachable says so; set once per change, not per frame. */
  function settleFlags(moving: boolean) {
    const r = run.current;
    if (!under.current || !side.current) return;
    under.current.inert = !r.open;
    // Collapsed and still: nothing in the sidebar is styled, laid out or painted.
    side.current.toggleAttribute("data-covered", !moving && !r.open);
  }

  function frame(now: number) {
    const r = run.current;
    const elapsed = (now - r.last) / 1000;
    r.last = now;
    const springs = [x.current, depth.current];
    // A stalled frame (hidden window, a long task): land instead of crawling on from where it froze.
    if (elapsed > 0.25) springs.forEach((spring) => spring.snap());
    const dt = Math.min(1 / 30, Math.max(0, elapsed));
    springs.forEach((spring) => spring.step(dt, TUNE));
    // A wall for the spring: a fast close stops at the gutter, it never swings past it.
    if (x.current.x < SNEAK) {
      x.current.x = SNEAK;
      x.current.v = Math.max(0, x.current.v);
    }
    const done = x.current.settled(0.25) && depth.current.settled(0.002);
    if (done) springs.forEach((spring) => spring.snap());
    apply();
    if (done) {
      r.raf = 0;
      settleFlags(false);
    } else {
      r.raf = requestAnimationFrame(frame);
    }
  }

  /** Read once, before any frame writes: the reserve plus the workspace button. */
  function measure() {
    const strip = inset();
    if (!strip) return;
    const before = strip.style.width;
    strip.style.width = "";
    run.current.insetFull = strip.scrollWidth;
    strip.style.width = before;
  }

  function kick() {
    const r = run.current;
    measure();
    settleFlags(true);
    if (reducedMotion()) {
      [x.current, depth.current].forEach((spring) => spring.snap());
      apply();
      settleFlags(false);
      return;
    }
    if (!r.raf) {
      r.last = performance.now();
      r.raf = requestAnimationFrame(frame);
    }
  }

  // Toggles retarget the springs; the first paint lands at once.
  const shown = useRef(false);
  useLayoutEffect(() => {
    const r = run.current;
    const fresh = !shown.current;
    shown.current = true;
    r.open = open;
    x.current.to = open ? r.sb : SNEAK;
    depth.current.to = open ? 1 : 0;
    if (fresh) {
      cancelAnimationFrame(r.raf);
      r.raf = 0;
      [x.current, depth.current].forEach((spring) => spring.snap());
      measure();
      r.laidOut = Number.NaN;
      apply();
      settleFlags(false);
      return;
    }
    kick();
  }, [open]);

  // Dragging the sidebar's edge: the panel follows the pointer, no spring.
  useLayoutEffect(() => {
    const r = run.current;
    r.sb = width;
    if (!r.open) return;
    x.current.to = width;
    if (!r.raf) {
      x.current.snap();
      apply();
    }
  }, [width]);

  // The card's bottom follows the window. Only a resize fires it.
  useLayoutEffect(() => {
    const node = shell.current;
    if (!node) return;
    run.current.height = node.clientHeight;
    const observer = new ResizeObserver(() => {
      run.current.height = node.clientHeight;
      if (!run.current.raf) apply();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The first paint is already in place from the render, not from an effect after it:
  // the content is laid out once, at its width, before anything measures it.
  const initial = useRef({
    main: { transform: `translate3d(${open ? width : SNEAK}px,0,0)` },
    content: { width: `calc(100% - ${open ? width : SNEAK}px)` },
    under: open ? {} : { opacity: 0 },
  }).current;

  useEffect(() => {
    const r = run.current;
    return () => cancelAnimationFrame(r.raf);
  }, []);

  return (
    <div ref={shell} className="sbx">
      <div ref={under} className="sbx-under" style={{ width, ...initial.under }}>
        <div ref={side} className="sbx-side">
          {sidebar}
        </div>
      </div>
      <div ref={main} className="sbx-main" style={initial.main}>
        <div ref={content} className="sbx-content" style={initial.content}>
          {children}
        </div>
      </div>
    </div>
  );
}
