import { describe, expect, it } from "vitest";
import { fileAddress, fileView, isFileUrl, previewRoot, rendersAsPage, servedRoot } from "./files";

describe("fileView", () => {
  it.each([
    ["report.html", "text"],
    ["INDEX.HTM", "text"],
    ["logo.svg", "text"],
    ["shot.PNG", "image"],
    ["icon.ico", "image"],
    ["doc.pdf", "browser"],
    ["docs/Manual.PDF", "browser"],
    ["clip.mp4", "browser"],
    ["notes.md", "text"],
    ["main.ts", "text"],
    ["Makefile", "text"],
    [".html", "text"],
  ])("%s → %s", (name, view) => {
    expect(fileView(name)).toBe(view);
  });
});

describe("rendersAsPage", () => {
  it.each([
    ["report.html", true],
    ["out/INDEX.HTM", true],
    ["logo.svg", true],
    ["doc.pdf", false],
    ["notes.md", false],
    ["dir.html/notes", false],
  ])("%s → %s", (name, renders) => {
    expect(rendersAsPage(name)).toBe(renders);
  });
});

describe("previewRoot", () => {
  it("is the worktree a file was opened from", () => {
    expect(previewRoot("/repo/out/report.html", "out/report.html")).toBe("/repo");
  });

  it("is the file's own folder outside a worktree", () => {
    expect(previewRoot("/tmp/x/report.html", "/tmp/x/report.html")).toBe("/tmp/x");
    expect(previewRoot("/report.html", "/report.html")).toBe("/");
  });
});

describe("isFileUrl", () => {
  it("knows its own scheme only", () => {
    expect(isFileUrl("crew-file://h1/a.html")).toBe(true);
    expect(isFileUrl("file:///a.html")).toBe(false);
    expect(isFileUrl("nonsense")).toBe(false);
  });
});

describe("fileAddress", () => {
  const served = servedRoot("crew-file://ab12/report/my%20page.html", "/Users/me/repo/report/my page.html");

  it("reads the root off the URL the file was opened at", () => {
    expect(served).toEqual({ host: "ab12", root: "/Users/me/repo" });
    expect(servedRoot("crew-file://ab12/other.html", "/Users/me/repo/report/index.html")).toBeNull();
    expect(servedRoot("https://example.com/index.html", "/index.html")).toBeNull();
  });

  it("names the file on disk as Chrome would, with its query and fragment", () => {
    expect(fileAddress("crew-file://ab12/report/my%20page.html", served)).toBe("file:///Users/me/repo/report/my%20page.html");
    expect(fileAddress("crew-file://ab12/report/b.html?x=1#top", served)).toBe("file:///Users/me/repo/report/b.html?x=1#top");
  });

  it("leaves anything it can't place on disk as it is", () => {
    expect(fileAddress("crew-file://other/a.html", served)).toBeNull();
    expect(fileAddress("https://example.com/", served)).toBeNull();
    expect(fileAddress("crew-file://ab12/a.html", null)).toBeNull();
  });
});
