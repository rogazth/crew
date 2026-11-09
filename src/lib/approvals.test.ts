import { describe, expect, it } from "vitest";
import { describeApproval, hasApprovalBody } from "./approvals";

const headline = (name: string, input: Record<string, unknown> | undefined, title = "") => describeApproval(name, input, title).headline;

describe("an approval's headline, whichever CLI asked", () => {
  it("is the same question for a shell call from every provider", () => {
    expect(headline("Bash", { command: "rm -rf dist" }, "rm -rf dist")).toBe("Run this command?");
    expect(headline("bash", { command: "touch /out/cmd.txt", cwd: "/repo" })).toBe("Run this command?");
    expect(headline("shell", { command: "sleep 30; echo slept" })).toBe("Run this command?");
  });

  it("names the file an edit touches, under any key the CLI uses", () => {
    expect(headline("Edit", { file_path: "/r/a.rs", old_string: "a", new_string: "b" }, "Edit a.rs")).toBe("Edit a.rs?");
    expect(headline("Write", { file_path: "/r/a.rs", content: "x" }, "Write a.rs")).toBe("Write a.rs?");
    expect(headline("NotebookEdit", { notebook_path: "/r/x.ipynb", new_source: "x" })).toBe("Edit x.ipynb?");
    expect(headline("edit", { filePath: "/r/src/a.rs", oldString: "a", newString: "b" }, "Edit a.rs")).toBe("Edit a.rs?");
    expect(headline("edit", { paths: ["/repo/a.txt"] }, "Write a.txt")).toBe("Write a.txt?");
    expect(headline("edit", { paths: ["/r/a", "/r/b", "/r/c"] }, "Edit 3 files")).toBe("Edit 3 files?");
    expect(headline("delete", { path: "/r/b.txt" }, "Delete b.txt")).toBe("Delete b.txt?");
  });

  it("asks to read a file by its name, with nothing else to show", () => {
    expect(describeApproval("Read", { file_path: "/Users/me/.zshrc" }, "Read .zshrc")).toMatchObject({ kind: "read", headline: "Read .zshrc?" });
    expect(headline("read", { filePath: "/other/x.rs" })).toBe("Read x.rs?");
    expect(headline("read", { target_file: "x.rs", path: "/r/x.rs" })).toBe("Read x.rs?");
  });

  it("calls an MCP tool by its own name, its server beside it", () => {
    expect(describeApproval("mcp__atlassian__createJiraIssue", { project: "CREW" }, "atlassian · createJiraIssue")).toMatchObject({
      headline: "Use createJiraIssue?",
      aside: "Atlassian",
    });
    expect(describeApproval("mcp__claude_ai_Notion__notion-fetch", {}, "Notion · notion fetch").aside).toBe("Notion");
  });

  it("says what the web calls reach", () => {
    expect(headline("WebFetch", { url: "https://docs.rs/serde", prompt: "x" }, "WebFetch")).toBe("Fetch docs.rs?");
    expect(headline("webfetch", { url: "https://example.com/a" }, "Fetch https://example.com/a")).toBe("Fetch example.com?");
    expect(headline("WebSearch", { query: "rust async" }, "Search rust async")).toBe("Search the web for “rust async”?");
  });

  it("reads Codex's and opencode's own asks as what they are", () => {
    expect(headline("permissions", { permissions: {} }, "More access: outside")).toBe("Allow more access?");
    expect(headline("external_directory", { resources: ["/other/dir/*"] }, "/other/dir/*")).toBe("Work outside the project?");
  });

  it("falls back to the tool's name, and to the title when the CLI had no name", () => {
    expect(headline("Skill", { skill: "foo" }, "Skill foo")).toBe("Use Skill?");
    expect(headline("tool", {}, "Tool")).toBe("Tool?");
    expect(headline("tool", { url: "https://example.com/a" }, "web_fetch: https://example.com/a")).toBe("Fetch example.com?");
  });
});

describe("whether a settled card opens", () => {
  it("opens only onto something the headline did not say", () => {
    expect(hasApprovalBody("Bash", { command: "ls" }, "ls")).toBe(true);
    expect(hasApprovalBody("edit", { paths: ["/repo/a.txt"] }, "Write a.txt")).toBe(false);
    expect(hasApprovalBody("edit", { path: "/repo/b.txt" }, "Edit b.txt")).toBe(false);
    expect(hasApprovalBody("edit", { paths: ["/a", "/b"] }, "Edit 2 files")).toBe(true);
    expect(hasApprovalBody("Edit", { file_path: "/a.rs", old_string: "a", new_string: "b" }, "Edit a.rs")).toBe(true);
    expect(hasApprovalBody("Read", { file_path: "/a.rs" }, "Read a.rs")).toBe(false);
    expect(hasApprovalBody("delete", { path: "/r/b.txt" }, "Delete b.txt")).toBe(false);
    expect(hasApprovalBody("mcp__plain__echo", { text: "one" }, "plain · echo")).toBe(false);
    expect(hasApprovalBody("mcp__x__y", {}, "x · y")).toBe(false);
  });
});

describe("a settled approval's line", () => {
  const line = (name: string, input: Record<string, unknown>, title = "") => {
    const view = describeApproval(name, input, title);
    return [view.done, view.refused];
  };
  it("says what happened, or what did not", () => {
    expect(line("Bash", { command: "ls" })).toEqual(["Ran a command", "Didn't run the command"]);
    expect(line("Edit", { file_path: "/a.rs", old_string: "a", new_string: "b" })).toEqual(["Edited a.rs", "Didn't edit a.rs"]);
    expect(line("Write", { file_path: "/CHANGELOG.md", content: "x" })).toEqual(["Wrote CHANGELOG.md", "Didn't write CHANGELOG.md"]);
    expect(line("edit", { paths: ["/a", "/b", "/c"] }, "Edit 3 files")).toEqual(["Edited 3 files", "Didn't edit 3 files"]);
    expect(line("delete", { path: "/r/b.txt" }, "Delete b.txt")).toEqual(["Deleted b.txt", "Didn't delete b.txt"]);
    expect(line("ExitPlanMode", { plan: "1." })).toEqual(["Plan approved", "Plan rejected"]);
    expect(line("mcp__plain__echo", { text: "one" })).toEqual(["Used echo", "Didn't use echo"]);
    expect(line("WebFetch", { url: "https://docs.rs/serde" })).toEqual(["Fetched docs.rs", "Didn't fetch docs.rs"]);
  });
});
