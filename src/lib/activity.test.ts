import { describe, expect, it } from "vitest";
import { buildActivity, phaseFailed, phaseKind, phaseLabel, summarize, type Phase } from "./activity";
import type { Block, ToolStatus } from "./blocks";

function tool(name: string, title: string, status: ToolStatus = "completed"): Block {
  return { id: `${name}-${title}`, role: "tool", text: title, tool: { callId: title, name, title, status } };
}

function phase(items: ActivityItem[], index = 0): Phase {
  const item = items[index];
  if (item?.kind !== "phase") throw new Error("not a phase");
  return item.phase;
}

type ActivityItem = ReturnType<typeof buildActivity>[number];

describe("buildActivity", () => {
  it("folds same-kind calls and splits on a change of kind", () => {
    const items = buildActivity([
      tool("Read", "Read a.ts"),
      tool("Grep", "Grep foo"),
      tool("Edit", "Edit a.ts"),
      tool("Bash", "npm test"),
      tool("Bash", "npm run lint"),
    ]);
    expect(items.map((item) => (item.kind === "phase" ? item.phase.kind : item.kind))).toEqual([
      "research",
      "edit",
      "run",
    ]);
    expect(phase(items, 2).blocks).toHaveLength(2);
  });

  it("keeps thinking and questions out of phases", () => {
    const items = buildActivity([
      { id: "r", role: "reasoning", text: "hmm" },
      tool("Read", "Read a.ts"),
      { id: "q", role: "question", text: "Color", question: { requestId: 1, questions: [] } },
      tool("Read", "Read b.ts"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["reasoning", "phase", "question", "phase"]);
  });
});

describe("phaseLabel", () => {
  it("names the file, counts many, and flips tense while live", () => {
    expect(phaseLabel(phase(buildActivity([tool("Read", "Read a.ts")])))).toBe("Read a.ts");
    expect(phaseLabel(phase(buildActivity([tool("Read", "Read a.ts"), tool("Read", "Read b.ts"), tool("Read", "Read a.ts")])))).toBe(
      "Read 2 files",
    );
    expect(phaseLabel(phase(buildActivity([tool("Read", "Read a.ts", "pending")])))).toBe("Reading a.ts");
  });

  it("describes searches and mixed research", () => {
    expect(phaseLabel(phase(buildActivity([tool("Grep", "Grep foo")])))).toBe("Searched the project");
    expect(phaseLabel(phase(buildActivity([tool("Grep", "Grep foo"), tool("Read", "Read a.ts")])))).toBe("Explored the project");
  });

  it("counts commands and edits", () => {
    expect(phaseLabel(phase(buildActivity([tool("Bash", "npm test")])))).toBe("Ran a command");
    expect(phaseLabel(phase(buildActivity([tool("Bash", "npm test"), tool("Bash", "npm lint", "pending")])))).toBe(
      "Running 2 commands",
    );
    expect(phaseLabel(phase(buildActivity([tool("Edit", "Edit a.ts"), tool("Write", "Write b.ts")])))).toBe("Edited 2 files");
  });

  it("uses the pending approval's tool for the kind", () => {
    const approval: Block = { id: "a", role: "approval", text: "npm run lint", approval: { requestId: 1, name: "Bash" } };
    expect(phaseLabel(phase(buildActivity([approval])))).toBe("Running a command");
  });
});

describe("summarize", () => {
  it("takes the first non-empty line without markdown", () => {
    expect(summarize("\n## **Plan**\n- do the thing")).toBe("Plan");
    expect(summarize("x".repeat(120), 10)).toBe("xxxxxxxxx…");
  });
});

describe("phaseKind", () => {
  it("reads the kind off the detail, whatever the provider called the tool", () => {
    const block: Block = {
      id: "x",
      role: "tool",
      text: "bash",
      tool: {
        callId: "1",
        name: "exec_command",
        title: "bash",
        status: "completed",
        detail: { kind: "command", command: "npm test", exitCode: 0 },
      },
    };
    expect(phaseKind(block)).toBe("run");
  });

  it("falls back to the tool name when no detail arrived", () => {
    expect(phaseKind(tool("Grep", "Grep foo"))).toBe("research");
  });

  it("groups a file read and a search into one research phase", () => {
    const read: Block = {
      id: "r",
      role: "tool",
      text: "read",
      tool: {
        callId: "1",
        name: "read",
        title: "read",
        status: "completed",
        detail: { kind: "file", path: "src/a.ts" },
      },
    };
    const grep: Block = {
      id: "g",
      role: "tool",
      text: "grep",
      tool: {
        callId: "2",
        name: "grep",
        title: "grep",
        status: "completed",
        detail: { kind: "search", query: "TODO", matches: 2 },
      },
    };
    const items = buildActivity([read, grep]);
    expect(items).toHaveLength(1);
    expect(phase(items).kind).toBe("research");
    expect(phaseLabel(phase(items))).toBe("Explored the project");
  });

  it("names the file from the detail instead of parsing the title", () => {
    const edit: Block = {
      id: "e",
      role: "tool",
      text: "apply_patch",
      tool: {
        callId: "1",
        name: "apply_patch",
        title: "apply_patch",
        status: "completed",
        detail: { kind: "edit", path: "src/lib/tabs.ts", added: 2, removed: 1 },
      },
    };
    expect(phaseLabel(phase(buildActivity([edit])))).toBe("Edited src/lib/tabs.ts");
  });
});

describe("phaseFailed", () => {
  it("is true when any call in the phase failed", () => {
    const items = buildActivity([tool("Bash", "npm run lint"), tool("Bash", "npm test", "failed")]);
    expect(phaseFailed(phase(items))).toBe(true);
  });

  it("is false when every call came back fine", () => {
    const items = buildActivity([tool("Bash", "npm run lint"), tool("Bash", "npm test")]);
    expect(phaseFailed(phase(items))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REVIEW: vacuity probe for `phaseKind > "groups a file read and a search into
// one research phase"`. The same two blocks WITHOUT any detail group exactly
// the same way, because kindOf("read") and kindOf("grep") are both "research".
// So the grouping half of that test passes with the detail branch of
// `phaseKind` deleted; only `phaseLabel` (via targetOf) exercises the feature.
// ---------------------------------------------------------------------------
describe("REVIEW: what the detail branch of phaseKind actually buys", () => {
  it("groups by name alone, detail or no detail", () => {
    const items = buildActivity([tool("read", "read"), tool("grep", "grep")]);
    expect(items).toHaveLength(1);
    expect(phase(items).kind).toBe("research");
  });
});
