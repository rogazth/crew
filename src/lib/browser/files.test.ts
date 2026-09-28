import { describe, expect, it } from "vitest";
import { fileView, isFileUrl, previewRoot } from "./files";

describe("fileView", () => {
  it.each([
    ["report.html", "page"],
    ["INDEX.HTM", "page"],
    ["logo.svg", "page"],
    ["shot.PNG", "image"],
    ["icon.ico", "image"],
    ["doc.pdf", "media"],
    ["clip.mp4", "media"],
    ["notes.md", "text"],
    ["main.ts", "text"],
    ["Makefile", "text"],
    [".html", "text"],
  ])("%s → %s", (name, view) => {
    expect(fileView(name)).toBe(view);
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
