import { describe, expect, it } from "vitest";
import { buildActivity, phaseLabel, summarize, type Phase } from "./activity";
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
