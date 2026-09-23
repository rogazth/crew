import { describe, expect, it } from "vitest";
import { approvalHeadline, approvalKey, approvalView } from "./approval";

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe("approvalHeadline", () => {
  it("names the file an edit or a read touches", () => {
    expect(approvalHeadline("Edit", { file_path: "/w/src/app.ts" }, "Edit")).toBe("Wants to edit app.ts");
    expect(approvalHeadline("write", { path: "notes.md" }, "Write")).toBe("Wants to edit notes.md");
    expect(approvalHeadline("NotebookEdit", {}, "x")).toBe("Wants to edit a file");
    expect(approvalHeadline("Read", { file_path: "/w/a.txt" }, "Read")).toBe("Wants to read a.txt");
    expect(approvalHeadline("read", undefined, "Read")).toBe("Wants to read a file");
  });

  it("says a shell call runs a command", () => {
    expect(approvalHeadline("Bash", { command: "ls" }, "ls")).toBe("Wants to run a command");
  });

  it("falls back to the tool's name and title", () => {
    expect(approvalHeadline("WebFetch", { url: "https://x" }, "Fetch x")).toBe("Wants to use WebFetch: Fetch x");
  });

  it("ignores a path that is not a string", () => {
    expect(approvalHeadline("Edit", { file_path: 42 }, "Edit")).toBe("Wants to edit a file");
  });
});

describe("approvalView", () => {
  it("shows a command as the command", () => {
    expect(approvalView("Bash", { command: "rm -rf build" })).toEqual({ kind: "command", code: "rm -rf build" });
  });

  it("shows an edit as a diff of the file's leaf", () => {
    expect(approvalView("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" })).toEqual({
      kind: "diff",
      name: "a.ts",
      before: "a",
      after: "b",
    });
    expect(approvalView("Write", { path: "b.md", content: "hello" })).toEqual({
      kind: "diff",
      name: "b.md",
      before: "",
      after: "hello",
    });
  });

  it("falls back to the raw input when an edit carries no text", () => {
    expect(approvalView("Edit", { file_path: "/w/a.ts" })).toEqual({
      kind: "json",
      code: JSON.stringify({ file_path: "/w/a.ts" }, null, 2),
    });
  });

  it("shows other tools' input as JSON, and nothing without input", () => {
    expect(approvalView("Grep", { pattern: "x" })).toEqual({ kind: "json", code: '{\n  "pattern": "x"\n}' });
    expect(approvalView("Grep", {})).toBeNull();
    expect(approvalView("Grep", undefined)).toBeNull();
  });
});

describe("approvalKey", () => {
  it("allows on Enter and denies on Escape", () => {
    expect(approvalKey(key("Enter"), false)).toBe("allow");
    expect(approvalKey(key("Escape"), false)).toBe("deny");
    expect(approvalKey(key("a"), false)).toBeNull();
  });

  it("leaves chords and text fields alone", () => {
    expect(approvalKey(key("Enter", { metaKey: true }), false)).toBeNull();
    expect(approvalKey(key("Enter", { ctrlKey: true }), false)).toBeNull();
    expect(approvalKey(key("Escape", { altKey: true }), false)).toBeNull();
    expect(approvalKey(key("Enter"), true)).toBeNull();
  });
});
