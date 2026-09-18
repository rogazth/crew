import { describe, expect, it } from "vitest";
import {
  activityDigest,
  agentThreadLabel,
  buildActivity,
  gapBefore,
  groupRows,
  phaseLabel,
  showThinking,
  summarize,
  type Row,
} from "./transcript";
import type { Block, ToolDetail } from "./types";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

let n = 0;
const id = () => `b${(n += 1)}`;

const msg = (role: Block["role"], text: string, at = NOW): Block => ({ id: id(), role, text, at });

const tool = (name: string, detail: ToolDetail, at = NOW, status: Block["tool"] = undefined): Block => ({
  id: id(),
  role: "tool",
  text: name,
  at,
  tool: { callId: id(), name, title: name, status: "completed", detail },
  ...(status ? {} : {}),
});

const pending = (name: string, detail: ToolDetail): Block => ({
  id: id(),
  role: "tool",
  text: name,
  at: NOW,
  tool: { callId: id(), name, title: name, status: "pending", detail },
});

const read = (path: string, at = NOW) => tool("Read", { kind: "file", path }, at);
const edit = (path: string, at = NOW) => tool("Edit", { kind: "edit", path }, at);
const cmd = (command: string, at = NOW) => tool("Bash", { kind: "command", command, exitCode: 0 }, at);

const letterIn = (name: string, agentId: string, text: string, at = NOW): Block => ({
  id: id(),
  role: "user",
  text,
  at,
  fromAgent: { id: agentId, name },
});

const letterOut = (to: string, text: string, at = NOW): Block =>
  tool("message_agent", { kind: "message", to, text }, at);

describe("phases", () => {
  it("groups consecutive calls of the same kind", () => {
    const items = buildActivity([read("a.ts"), read("b.ts"), edit("c.ts")]);
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("phase");
    expect(items[0]!.kind === "phase" && items[0]!.phase.blocks).toHaveLength(2);
  });

  it("breaks a phase on a thought", () => {
    const items = buildActivity([read("a.ts"), msg("reasoning", "hm"), read("b.ts")]);
    expect(items.map((i) => i.kind)).toEqual(["phase", "reasoning", "phase"]);
  });

  it("names a phase by what it did, in the right tense", () => {
    const items = buildActivity([read("a.ts"), read("b.ts"), read("c.ts")]);
    const phase = items[0]!.kind === "phase" ? items[0]!.phase : null;
    expect(phaseLabel(phase!)).toBe("Read 3 files");
  });

  it("uses the present tense while a call is open", () => {
    const items = buildActivity([pending("Bash", { kind: "command", command: "npm test" })]);
    const phase = items[0]!.kind === "phase" ? items[0]!.phase : null;
    expect(phaseLabel(phase!)).toBe("Running a command");
  });

  it("names a single file rather than counting to one", () => {
    const items = buildActivity([edit("/x/y/tabs.ts")]);
    const phase = items[0]!.kind === "phase" ? items[0]!.phase : null;
    expect(phaseLabel(phase!)).toBe("Edited tabs.ts");
  });

  it("digests a whole run down to its two biggest kinds", () => {
    const items = buildActivity([
      cmd("a"),
      cmd("b"),
      cmd("c"),
      read("x.ts"),
      read("y.ts"),
      msg("reasoning", "thinking"),
    ]);
    const digest = activityDigest(items);
    expect(digest.kind).toBe("run");
    expect(digest.label).toBe("Ran 3 commands, read 2 files");
  });

  it("digests a run that was only thinking", () => {
    const items = buildActivity([msg("reasoning", "one"), msg("reasoning", "two")]);
    expect(activityDigest(items)).toEqual({ kind: "thought", label: "Thought 2 times" });
  });
});

describe("groupRows", () => {
  it("folds tools, reasoning and approvals into one activity row", () => {
    const rows = groupRows([msg("user", "go"), msg("reasoning", "hm"), read("a.ts"), msg("assistant", "done")]);
    expect(rows.map((r) => r.kind)).toEqual(["date", "message", "activity", "message"]);
  });

  it("drops a streaming assistant block that has no text yet", () => {
    const empty: Block = { id: "s", role: "assistant", text: "", streaming: true, at: NOW };
    expect(groupRows([empty])).toHaveLength(0);
  });

  it("drops hidden blocks", () => {
    const hidden: Block = { id: "h", role: "user", text: "secret", hidden: true, at: NOW };
    expect(groupRows([hidden])).toHaveLength(0);
  });

  it("inserts a date break after a long gap", () => {
    const rows = groupRows([msg("user", "one", NOW), msg("user", "two", NOW + 40 * MIN)]);
    expect(rows.filter((r) => r.kind === "date")).toHaveLength(2);
  });

  it("does not break the date for a short gap", () => {
    const rows = groupRows([msg("user", "one", NOW), msg("user", "two", NOW + 5 * MIN)]);
    expect(rows.filter((r) => r.kind === "date")).toHaveLength(1);
  });

  it("puts a turn's usage in a footer of its own", () => {
    const reply: Block = { ...msg("assistant", "done"), usage: { durationMs: 1_000 } };
    const rows = groupRows([reply]);
    expect(rows.map((r) => r.kind)).toEqual(["message", "footer"]);
  });
});

describe("agent letters group into a thread", () => {
  it("collects a run of letters from one peer", () => {
    const rows = groupRows([
      letterIn("Relay", "s-nerb", "one", NOW),
      letterIn("Relay", "s-nerb", "two", NOW + MIN),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<Row, { kind: "agent-thread" }>;
    expect(row.kind).toBe("agent-thread");
    expect(agentThreadLabel(row)).toBe("2 messages with Relay");
  });

  it("counts peers, not letters, when several agents wrote", () => {
    const rows = groupRows([
      letterIn("Relay", "s-nerb", "one", NOW),
      letterIn("scribe", "s-scribe", "two", NOW + MIN),
      letterIn("Relay", "s-nerb", "three", NOW + 2 * MIN),
    ]);
    const row = rows[0] as Extract<Row, { kind: "agent-thread" }>;
    expect(agentThreadLabel(row)).toBe("3 messages with 2 agents");
  });

  it("says message, singular, for one", () => {
    const rows = groupRows([letterIn("Relay", "s-nerb", "only", NOW)]);
    expect(agentThreadLabel(rows[0] as Extract<Row, { kind: "agent-thread" }>)).toBe(
      "1 message with Relay",
    );
  });

  it("groups outbound letters with inbound ones — it is one conversation", () => {
    const rows = groupRows([
      letterOut("s-nerb", "asking", NOW),
      letterIn("Relay", "s-nerb", "answering", NOW + MIN),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<Row, { kind: "agent-thread" }>;
    expect(row.messages.map((m) => m.direction)).toEqual(["out", "in"]);
  });

  it("breaks the group when a reply comes between", () => {
    const rows = groupRows([
      letterIn("Relay", "s-nerb", "one", NOW),
      msg("assistant", "answered", NOW + MIN),
      letterIn("Relay", "s-nerb", "two", NOW + 2 * MIN),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["agent-thread", "message", "agent-thread"]);
  });

  it("can be turned off, leaving ordinary rows", () => {
    const rows = groupRows([letterIn("Relay", "s-nerb", "one", NOW)], {
      groupAgentMessages: false,
    });
    // Ungrouped, a letter is an ordinary `role=user` block again — so it also
    // earns the date break that opens any run of user turns.
    expect(rows.map((r) => r.kind)).toEqual(["date", "message"]);
  });

  it("does not let a letter join the tool run around it", () => {
    const rows = groupRows([read("a.ts"), letterIn("Relay", "s-nerb", "hi"), read("b.ts")]);
    expect(rows.map((r) => r.kind)).toEqual(["activity", "agent-thread", "activity"]);
  });
});

describe("spacing", () => {
  const message = (block: Block): Row => ({ kind: "message", block });

  it("is tighter within a speaker than across one", () => {
    const user = message(msg("user", "a"));
    const agent = message(msg("assistant", "b"));
    expect(gapBefore(user, message(msg("user", "c")))).toBe(6);
    expect(gapBefore(user, agent)).toBe(20);
  });

  it("gives meta rows their own beat", () => {
    const user = message(msg("user", "a"));
    expect(gapBefore(user, { kind: "date", id: "d", at: NOW })).toBe(12);
  });

  it("hugs a footer to what it closes", () => {
    const agent = message(msg("assistant", "b"));
    expect(gapBefore(agent, { kind: "footer", id: "f", usage: {} })).toBe(6);
  });
});

describe("showThinking", () => {
  it("shows nothing when the agent is not working", () => {
    expect(showThinking([], false)).toBe(false);
  });

  it("fills the gap before the first token", () => {
    expect(showThinking([msg("user", "go")], true)).toBe(true);
  });

  it("stays out of the way once text is streaming", () => {
    const streaming: Block = { id: "s", role: "assistant", text: "partial", streaming: true };
    expect(showThinking([streaming], true)).toBe(false);
  });

  it("stays out of the way while a tool is pending — that row is the state", () => {
    expect(showThinking([pending("Bash", { kind: "command", command: "x" })], true)).toBe(false);
  });
});

describe("summarize", () => {
  it("takes the first real line and strips markdown noise", () => {
    expect(summarize("\n\n## **Heading**\nbody")).toBe("Heading");
  });

  it("truncates with an ellipsis", () => {
    expect(summarize("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("answers empty for empty", () => {
    expect(summarize("   \n  ")).toBe("");
  });
});
