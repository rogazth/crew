import { describe, expect, it } from "vitest";
import { cookieSourceLabel, importSummary } from "./cookies";

describe("cookieSourceLabel", () => {
  it("names the browser, then the profile", () => {
    expect(cookieSourceLabel({ id: "chrome/Profile 2", browser: "Chrome", profile: "Work" })).toBe("Chrome — Work");
    expect(cookieSourceLabel({ id: "arc/Default", browser: "Arc", profile: "" })).toBe("Arc");
  });
});

describe("importSummary", () => {
  it("counts what came over and what didn't", () => {
    expect(importSummary(1, 0)).toBe("Imported 1 cookie.");
    expect(importSummary(1204, 3)).toBe(
      "Imported 1,204 cookies. 3 couldn't be brought over: expired, bound to Google, or unreadable.",
    );
  });
});
