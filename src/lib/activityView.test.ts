import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import { anyFailed, foldOpen, holdsRow, hotBlockId, reasoningLabel, sameGroup } from "./activityView";

const tool = (id: string, status: "pending" | "completed" | "failed" = "completed"): Block => ({
  id,
  role: "tool",
  text: "",
  tool: { callId: id, name: "Bash", title: "ls", status },
});
const approval = (id: string, decided?: "allow"): Block => ({
  id,
  role: "approval",
  text: "Bash",
  approval: { requestId: 1, name: "Bash", ...(decided ? { decided } : {}) },
});

describe("sameGroup", () => {
  const onApprove = () => undefined;
  const onAnswer = () => undefined;
  const a = tool("a");
  const b = tool("b");
  const base = { blocks: [a, b], live: false, focusId: null, marked: null, onApprove, onAnswer };

  it("treats a fresh array of the same blocks as unchanged", () => {
    expect(sameGroup(base, { ...base, blocks: [a, b] })).toBe(true);
  });

  it("sees a changed, added or replaced block", () => {
    expect(sameGroup(base, { ...base, blocks: [a] })).toBe(false);
    expect(sameGroup(base, { ...base, blocks: [a, { ...b }] })).toBe(false);
  });

  it("sees every other prop", () => {
    expect(sameGroup(base, { ...base, live: true })).toBe(false);
    expect(sameGroup(base, { ...base, focusId: "a" })).toBe(false);
    expect(sameGroup(base, { ...base, marked: "a" })).toBe(false);
    expect(sameGroup(base, { ...base, onApprove: () => undefined })).toBe(false);
    expect(sameGroup(base, { ...base, onAnswer: () => undefined })).toBe(false);
  });
});

describe("hotBlockId", () => {
  it("is the newest open block of the live group", () => {
    const blocks = [approval("first"), tool("run", "pending"), approval("done", "allow")];
    expect(hotBlockId(blocks, true)).toBe("run");
  });

  it("is nothing for history or a group with nothing open", () => {
    expect(hotBlockId([approval("first")], false)).toBeUndefined();
    expect(hotBlockId([tool("a")], true)).toBeUndefined();
  });
});

describe("holdsRow", () => {
  const blocks = [tool("a"), tool("b")];

  it("holds the row a search sent the reader to, or the one still marked", () => {
    expect(holdsRow(blocks, "b", null)).toBe(true);
    expect(holdsRow(blocks, null, "a")).toBe(true);
    expect(holdsRow(blocks, "elsewhere", "b")).toBe(true);
  });

  it("holds nothing for rows outside it", () => {
    expect(holdsRow(blocks, "z", "y")).toBe(false);
    expect(holdsRow(blocks, null, null)).toBe(false);
  });
});

describe("foldOpen", () => {
  it("stays open while something waits on the user, pin or not", () => {
    expect(foldOpen(true, false, false, false)).toBe(true);
  });

  it("follows the reader's pin over everything else", () => {
    expect(foldOpen(false, false, true, true)).toBe(false);
    expect(foldOpen(false, true, false, false)).toBe(true);
  });

  it("opens unpinned while live or holding the focus", () => {
    expect(foldOpen(false, null, false, true)).toBe(true);
    expect(foldOpen(false, null, true, false)).toBe(true);
    expect(foldOpen(false, null, false, false)).toBe(false);
  });
});

describe("anyFailed", () => {
  it("spots a failed tool among the rest", () => {
    expect(anyFailed([tool("a"), tool("b", "failed")])).toBe(true);
    expect(anyFailed([tool("a"), approval("b")])).toBe(false);
  });
});

describe("reasoningLabel", () => {
  it("says Thinking while it streams, then its summary", () => {
    expect(reasoningLabel(true, "Checking the config")).toBe("Thinking");
    expect(reasoningLabel(false, "Checking the config")).toBe("Checking the config");
    expect(reasoningLabel(false, "")).toBe("Thought");
  });
});
