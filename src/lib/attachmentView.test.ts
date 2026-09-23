import { describe, expect, it } from "vitest";
import { lightboxStep, splitAttachments, wrapIndex } from "./attachmentView";

describe("splitAttachments", () => {
  it("puts images in the viewer strip and the rest in chips, each in order", () => {
    const shot = { name: "shot.png", path: "/t/shot.png" };
    const notes = { name: "notes.md", path: "/t/notes.md" };
    const tagged = { name: "raw", path: "/t/raw", kind: "image" as const };
    const svg = { name: "logo.svg", path: "/t/logo.svg" };
    expect(splitAttachments([shot, notes, tagged, svg])).toEqual({ images: [shot, tagged], others: [notes, svg] });
    expect(splitAttachments([])).toEqual({ images: [], others: [] });
  });
});

describe("wrapIndex", () => {
  it("walks forward and back around the strip", () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 1)).toBe(0);
  });
});

describe("lightboxStep", () => {
  it("maps the arrows and nothing else", () => {
    expect(lightboxStep("ArrowLeft")).toBe(-1);
    expect(lightboxStep("ArrowRight")).toBe(1);
    expect(lightboxStep("ArrowUp")).toBe(0);
    expect(lightboxStep("Escape")).toBe(0);
  });
});
