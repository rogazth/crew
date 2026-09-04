import { describe, expect, it } from "vitest";
import { groupRuns, isHeadingOnly } from "./markdownRuns";

const kinds = (text: string) => groupRuns(text).map((run) => run.kind);

describe("groupRuns", () => {
  it("keeps prose, headings and lists together", () => {
    expect(groupRuns("# Title\n\nSome `code` and a | pipe.\n\n- one\n- two\n\n1. a\n2. b")).toEqual([
      { kind: "prose", text: "# Title\n\nSome `code` and a | pipe.\n\n- one\n- two\n\n1. a\n2. b" },
    ]);
  });

  it("breaks fences, quotes, tables, rules and lone images out", () => {
    const text = [
      "Intro",
      "```ts",
      "const a = 1;",
      "```",
      "> quoted",
      "> more",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "![img](x.png)",
      "Last",
    ].join("\n");
    expect(groupRuns(text)).toEqual([
      { kind: "prose", text: "Intro" },
      { kind: "wide", text: "```ts\nconst a = 1;\n```" },
      { kind: "wide", text: "> quoted\n> more" },
      { kind: "wide", text: "| a | b |\n|---|---|\n| 1 | 2 |" },
      { kind: "wide", text: "---" },
      { kind: "wide", text: "![img](x.png)" },
      { kind: "prose", text: "Last" },
    ]);
  });

  it("pulls a fence out of a list but leaves an indented one in", () => {
    expect(kinds("- item\n```sh\nls\n```\n- next")).toEqual(["prose", "wide", "prose"]);
    expect(kinds("- item\n\n    ```sh\n    ls\n    ```\n- next")).toEqual(["prose"]);
  });

  it("treats an unclosed fence as wide to the end while streaming", () => {
    expect(groupRuns("Text\n```ts\nconst x")).toEqual([
      { kind: "prose", text: "Text" },
      { kind: "wide", text: "```ts\nconst x" },
    ]);
  });

  it("reads dashes under text as a heading, not a rule", () => {
    expect(kinds("Title\n---\nbody")).toEqual(["prose"]);
    expect(kinds("Title\n\n---\n\nbody")).toEqual(["prose", "wide", "prose"]);
  });

  it("splits a closing heading off so it captions the wide block", () => {
    expect(groupRuns("Intro\n\n## Table\n\n| a |\n|---|\n| 1 |")).toEqual([
      { kind: "prose", text: "Intro\n" },
      { kind: "prose", text: "## Table\n" },
      { kind: "wide", text: "| a |\n|---|\n| 1 |" },
    ]);
    expect(kinds("## Only\n\n```\nx\n```")).toEqual(["prose", "wide"]);
  });

  it("drops blank-only runs", () => {
    expect(groupRuns("")).toEqual([]);
    expect(groupRuns("\n\n")).toEqual([]);
    expect(kinds("```\nx\n```\n\n")).toEqual(["wide"]);
  });
});

describe("isHeadingOnly", () => {
  it("is true for headings alone", () => {
    expect(isHeadingOnly("## Diff\n")).toBe(true);
    expect(isHeadingOnly("# A\n\n## B")).toBe(true);
    expect(isHeadingOnly("## Diff\n\nsee below")).toBe(false);
    expect(isHeadingOnly("#hashtag")).toBe(false);
  });
});
