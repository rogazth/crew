import { describe, expect, it } from "vitest";
import type { Block, TurnUsage } from "./blocks";
import { foldTurns, gapBefore, groupRows, speaker, type Row } from "./transcriptRows";

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
    expect(gapBefore(reply, footer)).toBe("mt-2");
  });

  it("opens a gap when the speaker changes and keeps it tight when it does not", () => {
    const mine: Row = { kind: "message", block: block("user", "hi") };
    const theirs: Row = { kind: "message", block: block("assistant", "hello") };
    expect(gapBefore(mine, theirs)).toBe("mt-7");
    expect(gapBefore(theirs, theirs)).toBe("mt-2.5");
  });

  it("gives a note its own room on both sides", () => {
    const note: Row = { kind: "message", block: block("system", "Stopped") };
    const reply: Row = { kind: "message", block: block("assistant", "ok") };
    expect(gapBefore(reply, note)).toBe("mt-4");
    expect(gapBefore(note, reply)).toBe("mt-4");
  });

  it("does not count a bot's letter as you talking", () => {
    const letter: Row = {
      kind: "message",
      block: { ...block("user", "ping"), fromBot: { id: "a1", name: "Crew" } },
    };
    expect(speaker(letter)).toBe("meta");
  });

  it("counts a group and a footer as the agent talking", () => {
    expect(speaker({ kind: "activity", id: "a", blocks: [] })).toBe("agent");
    expect(speaker({ kind: "footer", id: "f", usage: COST })).toBe("agent");
    expect(speaker({ kind: "date", id: "d", at: 0 })).toBe("meta");
  });
});

describe("footer", () => {
  it("carries the reply's text onto its footer for copying", () => {
    const rows = groupRows([block("assistant", "the answer", { usage: COST })]);
    expect(rows[1]).toMatchObject({ kind: "footer", text: "the answer" });
  });
});

describe("foldTurns", () => {
  const turn = () => [
    block("user", "fix it", { at: 1_000 }),
    block("tool", "npm test", { tool: { callId: "c1", name: "Bash", title: "npm test", status: "completed" } }),
    block("assistant", "one failed, fixing", { at: 2_000 }),
    block("tool", "edit", { tool: { callId: "c2", name: "Edit", title: "edit", status: "failed" } }),
    block("assistant", "green", { at: 61_000, usage: { durationMs: 60_000 } }),
  ];

  it("folds a settled turn's work behind one line and leaves the answer under the question", () => {
    const rows = foldTurns(groupRows(turn()), false);
    expect(kinds(rows)).toEqual(["date", "message", "fold", "message", "footer"]);
    const fold = rows[2] as Extract<Row, { kind: "fold" }>;
    expect(kinds(fold.rows)).toEqual(["activity", "message", "activity"]);
    expect(fold.durationMs).toBe(60_000);
    expect(fold.failed).toBe(true);
    expect((rows[4] as Extract<Row, { kind: "footer" }>).folded).toBe(true);
  });

  it("leaves the turn the agent is still working on alone", () => {
    const rows = foldTurns(groupRows(turn()), true);
    expect(rows.some((row) => row.kind === "fold")).toBe(false);
  });

  it("does not fold work that is already one line", () => {
    const rows = foldTurns(
      groupRows([block("user", "run it"), block("tool", "npm test"), block("assistant", "green")]),
      false,
    );
    expect(kinds(rows)).toEqual(["message", "activity", "message"]);
  });

  it("does not fold a turn that never answered", () => {
    const rows = foldTurns(
      groupRows([block("user", "run it"), block("tool", "a"), block("assistant", "hm"), block("tool", "b")]),
      false,
    );
    expect(rows.some((row) => row.kind === "fold")).toBe(false);
  });

  it("times a turn from its question to its answer when the provider did not", () => {
    const blocks = turn();
    blocks[4] = block("assistant", "green", { at: 31_000 });
    const fold = foldTurns(groupRows(blocks), false).find((row) => row.kind === "fold") as Extract<Row, { kind: "fold" }>;
    expect(fold.durationMs).toBe(30_000);
  });

  it("folds every finished turn but the live one", () => {
    const rows = foldTurns(groupRows([...turn(), ...turn()]), true);
    expect(rows.filter((row) => row.kind === "fold")).toHaveLength(1);
  });
});
