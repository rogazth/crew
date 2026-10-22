import { describe, expect, it } from "vitest";
import {
  completeMention,
  folderChoices,
  foldersOf,
  mentionAt,
  mentionedFiles,
  mentionFolder,
  mentionTokens,
  mergeChoices,
  splitMentions,
} from "./mentions";
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

describe("splitMentions in an email", () => {
  it("leaves an at sign inside a word alone", () => {
    expect(splitMentions("write to prueba@gmail.com")).toEqual([{ kind: "text", text: "write to prueba@gmail.com" }]);
    expect(splitMentions("@src/a.ts, prueba@gmail.com")).toEqual([
      { kind: "mention", path: "src/a.ts", text: "@src/a.ts" },
      { kind: "text", text: ", prueba@gmail.com" },
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

describe("folders", () => {
  it("lists each folder of the index once", () => {
    const files = [...FILES, { name: "a.ts", path: "/w/src/a.ts", relative: "src/a.ts" }];
    expect(foldersOf(files, "/w").map((f) => [f.relative, f.name, f.path])).toEqual([
      ["src/lib/", "lib/", "/w/src/lib"],
      ["src/", "src/", "/w/src"],
    ]);
  });

  it("splits a query into its folder and the rest", () => {
    expect(mentionFolder("reference/t3")).toEqual({ folder: "reference/", rest: "t3" });
    expect(mentionFolder("refer")).toEqual({ folder: "", rest: "refer" });
  });

  it("offers a folder's entries, prefix matches and folders first", () => {
    const entries = [
      { name: "zeron", path: "/w/reference/zeron", dir: true, ignored: true },
      { name: "t3code", path: "/w/reference/t3code", dir: true, ignored: true },
      { name: "t3.md", path: "/w/reference/t3.md", dir: false, ignored: true },
      { name: "cursor", path: "/w/reference/cursor", dir: true, ignored: true },
      { name: ".hidden", path: "/w/reference/.hidden", dir: true, ignored: true },
    ];
    expect(folderChoices(entries, "reference/", "t3").map((c) => c.relative)).toEqual([
      "reference/t3code/",
      "reference/t3.md",
    ]);
    expect(folderChoices(entries, "reference/", "").length).toBe(4);
  });

  it("merges without repeats and caps the menu", () => {
    const a = { name: "a", path: "/w/a", relative: "a" };
    const b = { name: "b", path: "/w/b", relative: "b" };
    expect(mergeChoices([a], [a, b], 8)).toEqual([a, b]);
    expect(mergeChoices([a, b], [], 1)).toEqual([a]);
  });

  it("leaves a picked folder open so the menu goes on into it", () => {
    const folder = { name: "reference/", path: "/w/reference", relative: "reference/", dir: true };
    expect(completeMention("see @refer", 10, folder, { into: true })).toEqual({ text: "see @reference/", cursor: 15 });
    expect(completeMention("see @refer", 10, folder)).toEqual({ text: "see @reference/ ", cursor: 16 });
    expect(mentionTokens("@reference/ and @a.ts @a.ts")).toEqual(["reference/", "a.ts"]);
  });
});
