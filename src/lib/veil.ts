/**
 * Fade timing for streamed text.
 *
 * A chunk's fade tracks the stream's own cadence, so a slow stream dissolves
 * gently and a fast one keeps up instead of queueing a fade per token. The
 * cadence is an EMA of the gaps between appends, clamped so one stalled chunk
 * can't stretch the whole turn.
 */

/** Cadence assumed before the second append has anything to measure. */
export const VEIL_EMA_SEED_MS = 150;
export const VEIL_MIN_FADE_MS = 150;
export const VEIL_MAX_FADE_MS = 420;

const EMA_WEIGHT = 0.75;
/** A pause longer than this is a stall, not a cadence. */
const GAP_CLAMP_MS = 900;
const CADENCE_TO_FADE = 2.5;
/** Duration is served in steps: a value changing per token would restart the
 *  fades already running on screen. */
const BUCKET_MS = 30;

export function veilEmaNext(emaMs: number, gapMs: number): number {
  return emaMs * EMA_WEIGHT + Math.min(gapMs, GAP_CLAMP_MS) * (1 - EMA_WEIGHT);
}

export function veilDurationMs(emaMs: number): number {
  const stepped = Math.round((emaMs * CADENCE_TO_FADE) / BUCKET_MS) * BUCKET_MS;
  return Math.min(VEIL_MAX_FADE_MS, Math.max(VEIL_MIN_FADE_MS, stepped));
}
