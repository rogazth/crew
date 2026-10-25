export type Tune = { stiffness: number; damping: number };

/**
 * A damped spring, unit mass: stiffness pulls it to `to`, damping bleeds its
 * velocity. Stepped at 240Hz whatever the frame rate, so it moves the same on
 * a 60Hz and a 120Hz screen. Retargeting keeps the velocity, which is what
 * makes a reversal or a chase continuous instead of restarting.
 */
export class Spring {
  v = 0;
  constructor(
    public x: number,
    public to = x,
  ) {}
  step(dt: number, { stiffness, damping }: Tune) {
    for (let left = dt; left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      this.v += (-stiffness * (this.x - this.to) - damping * this.v) * h;
      this.x += this.v * h;
    }
  }
  settled(epsilon = 0.05) {
    return Math.abs(this.x - this.to) < epsilon && Math.abs(this.v) < epsilon * 10;
  }
  snap() {
    this.x = this.to;
    this.v = 0;
  }
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs `tick` every frame with the seconds since the last, until it says it is
 * done or is cancelled. A stalled frame (a hidden window, a long task) hands a
 * zero step and `stalled`, so a motion lands instead of crawling on.
 */
export function frames(tick: (dt: number, stalled: boolean) => boolean): () => void {
  let last = performance.now();
  let id = requestAnimationFrame(function frame(now) {
    const elapsed = (now - last) / 1000;
    last = now;
    if (tick(Math.min(1 / 30, Math.max(0, elapsed)), elapsed > 0.25)) id = requestAnimationFrame(frame);
  });
  return () => cancelAnimationFrame(id);
}
