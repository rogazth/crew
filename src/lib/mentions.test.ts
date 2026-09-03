import { describe, expect, it } from "vitest";
import { completeMention, mentionAt, mentionedFiles, splitMentions } from "./mentions";
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
  it("swaps the query for the path plus a space", () => {
    expect(completeMention("fix @tab now", 8, FILES[0]!)).toEqual({ text: "fix @src/lib/tabs.ts  now", cursor: 21 });
  });
});
