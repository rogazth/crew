import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import { clock } from "./time";
import {
  compactCount,
  firstLine,
  footerLine,
  isPinned,
  placeScroll,
  showThinking,
  usageDetail,
} from "./transcriptView";

const block = (over: Partial<Block>): Block => ({ id: "b", role: "assistant", text: "", ...over });

describe("showThinking", () => {
  it("is off while the agent is idle", () => {
    expect(showThinking([], false)).toBe(false);
  });

  it("fills the gap before anything arrives", () => {
    expect(showThinking([], true)).toBe(true);
    expect(showThinking([block({ role: "user", text: "hi" })], true)).toBe(true);
  });

  it("gives way to text that is streaming in", () => {
    expect(showThinking([block({ streaming: true, text: "Sure" })], true)).toBe(false);
    expect(showThinking([block({ role: "reasoning", streaming: true, text: "hmm" })], true)).toBe(false);
  });

  it("stays for a streaming block with no text yet, or a settled one", () => {
    expect(showThinking([block({ streaming: true })], true)).toBe(true);
    expect(showThinking([block({ text: "done" })], true)).toBe(true);
  });

  it("gives way to a pending tool, an open approval or an open question", () => {
    const tool = block({ role: "tool", tool: { callId: "c", name: "Bash", title: "ls", status: "pending" } });
    const approval = block({ role: "approval", approval: { requestId: 1, name: "Bash" } });
    const question = block({ role: "question", question: { requestId: 2, questions: [] } });
    expect(showThinking([tool], true)).toBe(false);
    expect(showThinking([approval], true)).toBe(false);
    expect(showThinking([question], true)).toBe(false);
    expect(showThinking([{ ...tool, tool: { ...tool.tool!, status: "completed" } }], true)).toBe(true);
  });
});

describe("isPinned", () => {
  it("counts the last 16px as the bottom", () => {
    expect(isPinned({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isPinned({ scrollHeight: 1000, scrollTop: 584, clientHeight: 400 })).toBe(true);
    expect(isPinned({ scrollHeight: 1000, scrollTop: 583, clientHeight: 400 })).toBe(false);
  });
});

describe("placeScroll", () => {
  it("follows the bottom while pinned", () => {
    expect(placeScroll({ scrollHeight: 2000, clientHeight: 400 }, true, 900)).toBe(2000);
  });

  it("keeps a reader further up the same distance from the bottom", () => {
    expect(placeScroll({ scrollHeight: 2000, clientHeight: 400 }, false, 900)).toBe(1100);
  });

  it("leaves a hidden tab alone", () => {
    expect(placeScroll({ scrollHeight: 0, clientHeight: 0 }, true, 0)).toBeNull();
    expect(placeScroll({ scrollHeight: 2000, clientHeight: 0 }, false, 900)).toBeNull();
  });
});

describe("firstLine", () => {
  it("skips blank lines", () => {
    expect(firstLine("\n  \nDone with the build\nmore")).toBe("Done with the build");
    expect(firstLine("  \n")).toBe("");
  });
});

describe("footerLine", () => {
  it("joins the time worked and the clock", () => {
    const at = Date.UTC(2026, 0, 2, 15, 4);
    expect(footerLine({ durationMs: 125_000 }, at)).toBe(`Worked for 2m 5s · ${clock(at)}`);
    expect(footerLine({ durationMs: 3_000 })).toBe("Worked for 3s");
    expect(footerLine({}, at)).toBe(clock(at));
  });

  it("says nothing without either", () => {
    expect(footerLine({ inputTokens: 5 })).toBeNull();
  });
});

describe("usageDetail", () => {
  it("shows tokens in and out, and the cost", () => {
    expect(usageDetail({ inputTokens: 12_345, outputTokens: 900, costUsd: 0.4567 })).toBe("12k in · 900 out · $0.46");
  });

  it("gives small costs three decimals", () => {
    expect(usageDetail({ costUsd: 0.0123 })).toBe("$0.012");
  });

  it("counts a missing side as zero", () => {
    expect(usageDetail({ outputTokens: 1_500 })).toBe("0 in · 1.5k out");
  });

  it("is null when the turn reported nothing", () => {
    expect(usageDetail({ durationMs: 10 })).toBeNull();
  });
});

describe("compactCount", () => {
  it("shortens thousands and millions", () => {
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1_000)).toBe("1.0k");
    expect(compactCount(9_940)).toBe("9.9k");
    expect(compactCount(10_000)).toBe("10k");
    expect(compactCount(2_345_678)).toBe("2.3M");
  });
});
