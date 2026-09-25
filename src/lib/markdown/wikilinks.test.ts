import { describe, expect, it } from "vitest";
import { headingsIn, newNotePath, resolvePath, resolveWikiLink, splitTarget } from "./wikilinks";
import type { ProjectFile } from "../types";

const ROOT = "/ws";
const files: ProjectFile[] = ["README.md", "notes/Plan.md", "notes/deep/Plan.md", "archive/Plan.md", "img/diagram.png"].map(
  (relative) => ({ relative, path: `${ROOT}/${relative}`, name: relative.split("/").pop()! }),
);

describe("splitTarget", () => {
  it("separates the heading", () => {
    expect(splitTarget("Plan#Goals")).toEqual({ file: "Plan", heading: "Goals" });
    expect(splitTarget("#Goals")).toEqual({ file: "", heading: "Goals" });
    expect(splitTarget("Plan")).toEqual({ file: "Plan", heading: null });
  });
});

describe("resolveWikiLink", () => {
  it("matches a bare name, case-insensitively, without .md", () => {
    expect(resolveWikiLink("readme", `${ROOT}/notes/x.md`, files)?.relative).toBe("README.md");
  });

  it("prefers the note next to the one linking", () => {
    expect(resolveWikiLink("Plan", `${ROOT}/archive/x.md`, files)?.relative).toBe("archive/Plan.md");
  });

  it("falls back to the shallowest match", () => {
    expect(resolveWikiLink("Plan", `${ROOT}/README.md`, files)?.relative).toBe("archive/Plan.md");
  });

  it("honours a path", () => {
    expect(resolveWikiLink("deep/Plan", `${ROOT}/README.md`, files)?.relative).toBe("notes/deep/Plan.md");
  });

  it("finds a non-note by its full name", () => {
    expect(resolveWikiLink("diagram.png", `${ROOT}/README.md`, files)?.relative).toBe("img/diagram.png");
  });

  it("misses what is not there", () => {
    expect(resolveWikiLink("Nope", `${ROOT}/README.md`, files)).toBeNull();
  });
});

describe("newNotePath", () => {
  it("creates next to the linking note", () => {
    expect(newNotePath("Ideas", `${ROOT}/notes/Plan.md`)).toBe(`${ROOT}/notes/Ideas.md`);
  });
});

describe("headingsIn", () => {
  it("lists headings and skips fenced code", () => {
    const text = "# One\ntext\n```sh\n# not a heading\n```\n## Two ##\n";
    expect(headingsIn(text)).toEqual([
      { level: 1, text: "One", from: 0 },
      { level: 2, text: "Two", from: text.indexOf("## Two") },
    ]);
  });
});

describe("resolvePath", () => {
  it("folds dot segments against the note's folder", () => {
    expect(resolvePath("/ws/notes/a.md", "../img/x.png")).toBe("/ws/img/x.png");
    expect(resolvePath("/ws/notes/a.md", "./b.md")).toBe("/ws/notes/b.md");
    expect(resolvePath("/ws/notes/a.md", "/abs/c.png")).toBe("/abs/c.png");
  });
});
