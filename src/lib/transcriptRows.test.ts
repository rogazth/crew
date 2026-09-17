import { describe, expect, it } from "vitest";
import type { Block, TurnUsage } from "./blocks";
import { gapBefore, groupRows, speaker, type Row } from "./transcriptRows";

const COST: TurnUsage = { costUsd: 0.02 };

let next = 0;
function block(role: Block["role"], text: string, extra: Partial<Block> = {}): Block {
  next += 1;
  return { id: `b${next}`, role, text, ...extra };
}

const kinds = (rows: Row[]) => rows.map((row) => row.kind);

describe("groupRows", () => {
  it("collapses everything the agent did into one group", () => {
    const rows = groupRows([
      block("user", "fix it"),
      block("reasoning", "thinking"),
      block("tool", "npm test"),
      block("tool", "npm run lint"),
      block("assistant", "green"),
    ]);
    expect(kinds(rows)).toEqual(["message", "activity", "message"]);
    expect((rows[1] as { blocks: Block[] }).blocks).toHaveLength(3);
  });

  it("starts a new group after the agent speaks", () => {
    const rows = groupRows([
      block("tool", "npm test"),
      block("assistant", "one failed"),
      block("tool", "npm test -- -u"),
    ]);
    expect(kinds(rows)).toEqual(["activity", "message", "activity"]);
  });

  it("leaves out a hidden turn and an empty reply that is still streaming", () => {
    const rows = groupRows([
      block("user", "[routine] due", { hidden: true }),
      block("assistant", "", { streaming: true }),
      block("assistant", "done"),
    ]);
    expect(kinds(rows)).toEqual(["message"]);
    expect((rows[0] as { block: Block }).block.text).toBe("done");
  });

  it("breaks the day when half an hour passed between messages", () => {
    const at = Date.parse("2026-09-17T09:00:00Z");
    const rows = groupRows([
      block("user", "morning", { at }),
      block("assistant", "hi", { at: at + 1000 }),
      block("user", "still there?", { at: at + 31 * 60_000 }),
    ]);
    expect(kinds(rows)).toEqual(["date", "message", "message", "date", "message"]);
  });

  it("does not break the day for a reply that came back late", () => {
    const at = Date.parse("2026-09-17T09:00:00Z");
    const rows = groupRows([
      block("user", "run the suite", { at }),
      block("assistant", "green", { at: at + 45 * 60_000 }),
    ]);
    expect(kinds(rows)).toEqual(["date", "message", "message"]);
  });
});

describe("the cost of a turn", () => {
  it("is a row under the reply that ended it", () => {
    const rows = groupRows([block("assistant", "green", { usage: COST })]);
    expect(kinds(rows)).toEqual(["message", "footer"]);
  });

  // The window holds the newest blocks, so a turn that ended on its fortieth
  // tool call has no reply in view to hang the cost on.
  it("is a row under the group when the turn ended on a tool call", () => {
    const rows = groupRows([
      block("tool", "npm test"),
      block("tool", "npm run lint", { usage: COST }),
    ]);
    expect(kinds(rows)).toEqual(["activity", "footer"]);
    expect((rows[1] as { usage: TurnUsage }).usage).toEqual(COST);
  });

  it("stays out of the group it belongs to, so the phase can fold", () => {
    const rows = groupRows([block("tool", "npm test", { usage: COST })]);
    const group = rows[0] as { kind: string; blocks: Block[] };
    expect(group.kind).toBe("activity");
    expect(group.blocks).toHaveLength(1);
    expect(rows[1]?.kind).toBe("footer");
  });

  it("waits for the reply to settle before it says anything", () => {
    const rows = groupRows([block("assistant", "green", { usage: COST, streaming: true })]);
    expect(kinds(rows)).toEqual(["message"]);
  });
});

describe("spacing", () => {
  it("hugs the footer to what it is about", () => {
    const reply: Row = { kind: "message", block: block("assistant", "green") };
    const footer: Row = { kind: "footer", id: "f", usage: COST };
    expect(gapBefore(reply, footer)).toBe("mt-1.5");
  });

  it("opens a gap when the speaker changes and keeps it tight when it does not", () => {
    const mine: Row = { kind: "message", block: block("user", "hi") };
    const theirs: Row = { kind: "message", block: block("assistant", "hello") };
    expect(gapBefore(mine, theirs)).toBe("mt-5");
    expect(gapBefore(theirs, theirs)).toBe("mt-1.5");
  });

  it("gives a note its own room on both sides", () => {
    const note: Row = { kind: "message", block: block("system", "Stopped") };
    const reply: Row = { kind: "message", block: block("assistant", "ok") };
    expect(gapBefore(reply, note)).toBe("mt-3");
    expect(gapBefore(note, reply)).toBe("mt-3");
  });

  it("does not count another agent's letter as you talking", () => {
    const letter: Row = {
      kind: "message",
      block: { ...block("user", "ping"), fromAgent: { id: "a1", name: "Crew" } },
    };
    expect(speaker(letter)).toBe("meta");
  });

  it("counts a group and a footer as the agent talking", () => {
    expect(speaker({ kind: "activity", id: "a", blocks: [] })).toBe("agent");
    expect(speaker({ kind: "footer", id: "f", usage: COST })).toBe("agent");
    expect(speaker({ kind: "date", id: "d", at: 0 })).toBe("meta");
  });
});
