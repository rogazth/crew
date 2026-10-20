import { describe, expect, it } from "vitest";
import { noteOf, notesOf, sizeLabel } from "./update";

describe("noteOf", () => {
  it("reads the commit type as the kind of news", () => {
    expect(noteOf("feat: agents drive tabs")).toEqual({ kind: "new", text: "Agents drive tabs" });
    expect(noteOf("fix(browser): keep the tab")).toEqual({ kind: "fixed", text: "Keep the tab" });
    expect(noteOf("refactor: split the updater")).toEqual({ kind: "improved", text: "Split the updater" });
  });

  it("drops housekeeping and keeps a line with no type as an improvement", () => {
    expect(noteOf("chore: bump deps")).toBeNull();
    expect(noteOf("docs: plan")).toBeNull();
    expect(noteOf("Faster startup")).toEqual({ kind: "improved", text: "Faster startup" });
  });
});

describe("notesOf", () => {
  it("takes the bullets of GitHub's generated notes without the author and link", () => {
    const body = [
      "## What's Changed",
      "* feat: a new thing by @rogazth in https://github.com/rogazth/crew/pull/12",
      "* chore: tidy by @rogazth in https://github.com/rogazth/crew/pull/13",
      "",
      "**Full Changelog**: https://github.com/rogazth/crew/compare/v1...v2",
    ].join("\n");
    expect(notesOf(body)).toEqual([{ kind: "new", text: "A new thing" }]);
  });

  it("reads the bullets the publish script writes", () => {
    expect(notesOf("- fix: crewd restarts\n- feat: sound")).toEqual([
      { kind: "fixed", text: "Crewd restarts" },
      { kind: "new", text: "Sound" },
    ]);
  });

  it("is empty for a body with no bullets", () => {
    expect(notesOf("Crew 0.3.16")).toEqual([]);
  });
});

describe("sizeLabel", () => {
  it("reads megabytes", () => {
    expect(sizeLabel(48_600_000)).toBe("48.6 MB");
  });
});
