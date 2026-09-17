import { describe, expect, it } from "vitest";
import {
  VEIL_EMA_SEED_MS,
  VEIL_MAX_FADE_MS,
  VEIL_MIN_FADE_MS,
  veilDurationMs,
  veilEmaNext,
} from "./veil";

describe("veil cadence", () => {
  it("settles on a steady stream's gap", () => {
    let ema = VEIL_EMA_SEED_MS;
    for (let i = 0; i < 40; i++) ema = veilEmaNext(ema, 50);
    expect(Math.round(ema)).toBe(50);
  });

  it("reads a stall as a long gap, not a longer one", () => {
    expect(veilEmaNext(160, 5000)).toBe(veilEmaNext(160, 1000));
  });

  it("holds the fade between the floor and the ceiling", () => {
    expect(veilDurationMs(0)).toBe(VEIL_MIN_FADE_MS);
    expect(veilDurationMs(10)).toBe(VEIL_MIN_FADE_MS);
    expect(veilDurationMs(1000)).toBe(VEIL_MAX_FADE_MS);
  });

  it("serves the duration in steps so a running fade keeps its timing", () => {
    expect(veilDurationMs(70)).toBe(veilDurationMs(72));
    expect(veilDurationMs(70)).toBe(200);
  });
});
