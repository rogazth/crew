/**
 * Fade timing for streamed text, ported from R4's veil
 * (reference/R4/crates/ui/src/markdown/veil.rs, itself R5's `FadePainter`).
 *
 * A chunk's fade lasts three times the stream's own cadence, so a slow stream
 * dissolves gently and a fast one keeps up instead of queueing a fade per token.
 * The cadence is an EMA of the gaps between appends, clamped so one stalled
 * chunk can't stretch the whole turn. The curve itself — text alpha
 * `1 - (1 - p)^1.6` — is the ramp the CSS rule carries.
 */

/** Cadence assumed before the second append has anything to measure. */
export const VEIL_EMA_SEED_MS = 160;
export const VEIL_MIN_FADE_MS = 120;
export const VEIL_MAX_FADE_MS = 400;
/** A pause longer than this is a stall, not a cadence. */
const GAP_CLAMP_MS = 1000;
/** Duration is served in steps: a value changing per token would restart the
 *  fades already running on screen. */
const BUCKET_MS = 40;
export function veilEmaNext(emaMs: number, gapMs: number): number {
  return emaMs * 0.7 + Math.min(gapMs, GAP_CLAMP_MS) * 0.3;
}

export function veilDurationMs(emaMs: number): number {
  const fade = Math.min(VEIL_MAX_FADE_MS, Math.max(VEIL_MIN_FADE_MS, emaMs * 3));
  return Math.round(fade / BUCKET_MS) * BUCKET_MS;
}
