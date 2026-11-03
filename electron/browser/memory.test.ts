import { describe, expect, it } from "vitest";
import { pressureOfLevel, pressureOfMemory } from "./memory";

describe("pressureOfLevel", () => {
  it("reads the kernel's levels", () => {
    expect(pressureOfLevel(1)).toBe("normal");
    expect(pressureOfLevel(2)).toBe("moderate");
    expect(pressureOfLevel(4)).toBe("critical");
  });

  it("takes anything unknown below warn as normal", () => {
    expect(pressureOfLevel(0)).toBe("normal");
  });
});

describe("pressureOfMemory", () => {
  it("goes by the share still available", () => {
    expect(pressureOfMemory(1000, 500)).toBe("normal");
    expect(pressureOfMemory(1000, 100)).toBe("moderate");
    expect(pressureOfMemory(1000, 40)).toBe("critical");
  });

  it("is normal when the total is unknown", () => {
    expect(pressureOfMemory(0, 0)).toBe("normal");
  });
});
