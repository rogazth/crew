import { describe, expect, it } from "vitest";
import { claudeFastShown, claudeFastTitle } from "./fastMode";
import type { FastMode } from "./protocol";

const at = (availability: FastMode["availability"]): FastMode => ({ availability });

describe("claudeFastShown", () => {
  it("shows the toggle when the account can use fast mode or is cooling down", () => {
    expect(claudeFastShown(at("available"))).toBe(true);
    expect(claudeFastShown(at("cooldown"))).toBe(true);
  });

  it("hides the toggle until the account is known to be able to use it", () => {
    expect(claudeFastShown(at("hidden"))).toBe(false);
    expect(claudeFastShown(at("unknown"))).toBe(false);
    expect(claudeFastShown(null)).toBe(false);
  });
});

describe("claudeFastTitle", () => {
  it("says when fast resumes during a cooldown, whichever way it is set", () => {
    expect(claudeFastTitle(at("cooldown"), false)).toBe("Rate limited — fast resumes after a cooldown");
    expect(claudeFastTitle(at("cooldown"), true)).toBe("Rate limited — fast resumes after a cooldown");
  });

  it("names what a click does when the account can use fast mode", () => {
    expect(claudeFastTitle(at("available"), true)).toBe("Running in fast mode — click for standard");
    expect(claudeFastTitle(at("available"), false)).toBe("A faster run of this model");
  });
});
