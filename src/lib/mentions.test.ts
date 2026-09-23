import { describe, expect, it } from "vitest";
import { completeMention, mentionAt, mentionedFiles, searchFiles, splitMentions } from "./mentions";
import type { ProjectFile } from "./types";

const FILES: ProjectFile[] = [
  { name: "tabs.ts", path: "/w/src/lib/tabs.ts", relative: "src/lib/tabs.ts" },
  { name: "README.md", path: "/w/README.md", relative: "README.md" },
];

describe("mentionAt", () => {
  it("finds the token the caret is in", () => {
    expect(mentionAt("fix @src/li", 11)).toEqual({ start: 4, end: 11, query: "src/li" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("answers null when there is no at sign before the caret", () => {
    expect(mentionAt("plain text", 5)).toBeNull();
    expect(mentionAt("before @after", 3)).toBeNull();
  });

  it("covers the whole path when the caret sits in the middle of it", () => {
    expect(mentionAt("open @src/lib/tabs.ts now", 9)).toEqual({ start: 5, end: 21, query: "src" });
  });

  it("ignores at signs glued to a word or left behind the caret", () => {
    expect(mentionAt("mail me@host", 12)).toBeNull();
    expect(mentionAt("@src/lib done", 13)).toBeNull();
  });
});

describe("splitMentions", () => {
  it("cuts the text around known files", () => {
    const known = new Set(["src/lib/tabs.ts"]);
    expect(splitMentions("see @src/lib/tabs.ts and @nope", known)).toEqual([
      { kind: "text", text: "see " },
      { kind: "mention", path: "src/lib/tabs.ts", text: "@src/lib/tabs.ts" },
      { kind: "text", text: " and @nope" },
    ]);
  });

  it("marks every mention when no known set is given", () => {
    expect(splitMentions("@a and @b")).toEqual([
      { kind: "mention", path: "a", text: "@a" },
      { kind: "text", text: " and " },
      { kind: "mention", path: "b", text: "@b" },
    ]);
  });
});

describe("searchFiles", () => {
  const many: ProjectFile[] = Array.from({ length: 12 }, (_, n) => ({
    name: `f${n}.ts`,
    path: `/w/f${n}.ts`,
    relative: `f${n}.ts`,
  }));

  it("lists the first files, capped, before anything is typed", () => {
    expect(searchFiles("", many).map((f) => f.name)).toEqual(many.slice(0, 8).map((f) => f.name));
    expect(searchFiles("", many, 3)).toHaveLength(3);
  });

  it("keeps only the files that match, best first", () => {
    const files: ProjectFile[] = [
      ...FILES,
      { name: "terminalTabs.ts", path: "/w/src/lib/terminalTabs.ts", relative: "src/lib/terminalTabs.ts" },
    ];
    expect(searchFiles("tabs", files).map((f) => f.name)).toEqual(["tabs.ts", "terminalTabs.ts"]);
    expect(searchFiles("zzz", files)).toEqual([]);
  });

  it("caps the hits at the limit", () => {
    expect(searchFiles("f", many, 5)).toHaveLength(5);
  });
});

describe("mentionedFiles", () => {
  it("resolves in order without repeats", () => {
    expect(mentionedFiles("@README.md then @src/lib/tabs.ts and @README.md", FILES).map((f) => f.name)).toEqual([
      "README.md",
      "tabs.ts",
    ]);
  });
});

describe("completeMention", () => {
  it("does nothing when the caret is not in a mention", () => {
    expect(completeMention("fix it", 3, FILES[0]!)).toBeNull();
  });

  it("swaps the query for the path plus a space", () => {
    expect(completeMention("fix @tab now", 8, FILES[0]!)).toEqual({ text: "fix @src/lib/tabs.ts  now", cursor: 21 });
  });
});
