import { expect, it } from "vitest";
import { MIN_SAVE_MS } from "./timing";

it("holds a save spinner inside the 300-500ms range that neither flashes nor drags", () => {
  expect(MIN_SAVE_MS).toBeGreaterThanOrEqual(300);
  expect(MIN_SAVE_MS).toBeLessThanOrEqual(500);
});
