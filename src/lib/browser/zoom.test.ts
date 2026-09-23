import { describe, expect, it } from "vitest";
import { stepZoom, ZOOM_STEPS, zoomLabel } from "./zoom";

describe("stepZoom", () => {
  it("walks the steps both ways and resets", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.5, 0)).toBe(1);
  });

  it("stops at both ends", () => {
    expect(stepZoom(ZOOM_STEPS.at(-1)!, 1)).toBe(ZOOM_STEPS.at(-1));
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0]);
  });

  it("moves to the nearest step from a factor between two", () => {
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(1);
  });

  it("does not stall on float noise around a step", () => {
    expect(stepZoom(1.0999999, 1)).toBe(1.25);
    expect(stepZoom(0.9000001, -1)).toBe(0.8);
  });
});

describe("zoomLabel", () => {
  it("rounds to a whole percent", () => {
    expect(zoomLabel(1.1)).toBe("110%");
    expect(zoomLabel(0.67)).toBe("67%");
    expect(zoomLabel(0.333)).toBe("33%");
  });
});
