import { describe, expect, it } from "vitest";
import { describeCli } from "./cli";

describe("describeCli", () => {
  it("says where the link goes, and where it is", () => {
    expect(describeCli({ state: "absent", dir: "/usr/local/bin" })).toContain("links into /usr/local/bin");
    expect(describeCli({ state: "installed", link: "/usr/local/bin/crew", onPath: true })).toContain(
      "Linked at /usr/local/bin/crew.",
    );
  });

  it("warns when the shell does not look where the link is", () => {
    expect(describeCli({ state: "installed", link: "/x/crew", onPath: false })).toContain("not on your shell's PATH");
  });
});
