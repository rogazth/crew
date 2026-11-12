import { useEffect, useRef } from "react";
import type { OrbState } from "thinking-orbs";
import { MODE_FRAMES, paintFrame, resolvePreset, type Dot, type OrbFrame } from "thinking-orbs/engine";
import { useDarkScheme } from "../hooks/useDarkScheme";

/** The inline orb's size, in CSS px: the library tunes a preset for it. */
const SIZE = 20;
/** How long one state takes to turn into the next. */
const MORPH_MS = 520;

type Drawn = { state: OrbState; frame: (now: number) => OrbFrame };

function drawn(state: OrbState): Drawn {
  const { mode, speed, opts } = resolvePreset(state, SIZE);
  const frameOf = MODE_FRAMES[mode];
  return { state, frame: (now) => frameOf(SIZE, (now / 1000) * speed, opts) };
}

const ease = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);

/** Dots in order round the centre, so the i-th of one state meets a neighbour in the next. */
function byAngle(dots: Dot[]): Dot[] {
  const c = SIZE / 2;
  return [...dots].sort((a, b) => Math.atan2(a.y - c, a.x - c) - Math.atan2(b.y - c, b.x - c));
}

/**
 * One state's frame becoming the next's: every dot travels to a partner in
 * the new shape (the smaller set lends its dots twice), the whole orb draws
 * in a little at the middle of the move, and edges fade across.
 */
function blend(from: OrbFrame, to: OrbFrame, f: number): OrbFrame {
  const a = byAngle(from.dots);
  const b = byAngle(to.dots);
  const n = Math.max(a.length, b.length);
  const c = SIZE / 2;
  const pinch = 1 - 0.28 * Math.sin(Math.PI * f);
  const dots: Dot[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = a[Math.floor((i * a.length) / n)];
    const q = b[Math.floor((i * b.length) / n)];
    if (!p || !q) continue;
    const lerp = (x: number, y: number) => x + (y - x) * f;
    dots.push({
      x: c + (lerp(p.x, q.x) - c) * pinch,
      y: c + (lerp(p.y, q.y) - c) * pinch,
      z: lerp(p.z, q.z),
      r: lerp(p.r, q.r),
      white: lerp(p.white, q.white),
      a: lerp(p.a ?? 1, q.a ?? 1),
    });
  }
  dots.sort((x, y) => x.z - y.z);
  const lines = [
    ...from.lines.map((line) => ({ ...line, a: (line.a ?? 1) * (1 - f) })),
    ...to.lines.map((line) => ({ ...line, a: (line.a ?? 1) * f })),
  ];
  return { dots, lines };
}

/**
 * The dotted orb that turns while the agent works, in the inline size. A new
 * state does not cut in: the dots of the old one travel into the new one's
 * shape. It follows the app's scheme (the root's `dark` class is not one),
 * stands still for reduced motion, and stops drawing off screen.
 */
export function WorkOrb({ state, label, className }: { state: OrbState; label: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dark = useDarkScheme();
  // What the loop reads each frame: the state now, and the one it is leaving.
  const motion = useRef<{ to: Drawn; from: Drawn | null; since: number }>({ to: drawn(state), from: null, since: 0 });

  useEffect(() => {
    const held = motion.current;
    if (held.to.state === state) return;
    const now = performance.now();
    // Caught mid-move, it sets off from the state it was leaving to: close enough, and never a jump.
    motion.current = { to: drawn(state), from: held.to, since: now };
  }, [state]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(SIZE * dpr);
    el.height = Math.round(SIZE * dpr);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = (now: number) => {
      const { to, from, since } = motion.current;
      const f = from ? Math.min(1, (now - since) / MORPH_MS) : 1;
      if (from && f >= 1) motion.current = { to, from: null, since };
      const frame = from && f < 1 ? blend(from.frame(now), to.frame(now), ease(f)) : to.frame(now);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      paintFrame(ctx, frame, dark);
    };
    if (still) {
      paint(600);
      return;
    }
    let raf = 0;
    let running = false;
    let seen = true;
    const loop = (now: number) => {
      paint(now);
      if (running) raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || !seen || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const watch = new IntersectionObserver(([entry]) => {
      seen = entry?.isIntersecting ?? true;
      if (seen) start();
      else stop();
    });
    watch.observe(el);
    const onVisible = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisible);
    paint(performance.now());
    start();
    return () => {
      stop();
      watch.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [dark]);

  return <canvas ref={canvas} role="img" aria-label={label} className={className} style={{ width: SIZE, height: SIZE, display: "block" }} />;
}
