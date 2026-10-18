import { describe, expect, it } from "vitest";
import { layoutFor, refusal } from "./layout-plan";

const home = "/Users/me";

describe("the layout a build gives its data dir", () => {
  it("keeps the release's folders where they always were", () => {
    expect(layoutFor({ release: true, local: false, home })).toEqual({
      workDir: "/Users/me/.crew",
      homeFolder: "/Users/me/Crew",
    });
  });

  it("gives dev and local builds work dirs of their own", () => {
    expect(layoutFor({ release: false, local: false, home })).toEqual({ workDir: "/Users/me/.crew-dev" });
    expect(layoutFor({ release: false, local: true, home })).toEqual({ workDir: "/Users/me/.crew-local" });
  });

  it("leaves a data dir somebody pointed the app at to keep everything inside it", () => {
    expect(layoutFor({ release: false, local: false, home, userData: "/tmp/ce-1/config/Crew Dev" })).toBeNull();
  });

  it("ignores the variables in the release", () => {
    expect(layoutFor({ release: true, local: false, home, userData: "/d", workDir: "/w" })?.workDir).toBe(
      "/Users/me/.crew",
    );
  });

  it("takes a work dir it is given over every other default", () => {
    expect(layoutFor({ release: false, local: false, home, userData: "/c/.crew-dev", workDir: "/w" })).toEqual({
      workDir: "/w",
    });
  });
});

describe("an e2e launch", () => {
  it("refuses to start without a data dir of its own", () => {
    expect(refusal(true, undefined)).toMatch(/CREW_USER_DATA/);
    expect(refusal(true, "/tmp/ce-1/config/Crew Dev")).toBeNull();
    expect(refusal(false, undefined)).toBeNull();
  });
});
