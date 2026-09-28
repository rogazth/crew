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
    expect(importSummary(1204, 3)).toBe("Imported 1,204 cookies. 3 couldn't be brought over: expired or unreadable.");
  });

  it("says Google's sign-ins stay behind, and how to get them", () => {
    expect(importSummary(12, 0, 40)).toBe(
      "Imported 12 cookies. Google and YouTube accounts stay where they are: sign in to Google here to use them.",
    );
    expect(importSummary(12, 2, 40)).toContain("2 couldn't be brought over");
  });
});
