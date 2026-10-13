import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import type { ToolDetail } from "./protocol";
import { agentMeta, firstLine, foldsLongText, nativeName, nativeReport, startedOf, startedSessionsSentence } from "./orchestration";
import { foldTurns, groupRows, speaker, type Row } from "./transcriptRows";

const tool = (detail: ToolDetail): Block => ({
  id: "t",
  role: "tool",
  text: "",
  tool: { callId: "c", name: "x", title: "x", status: "completed", detail },
});

describe("agent cards", () => {
  it("says tokens and where it stands, with how long it took once it ended", () => {
    expect(agentMeta({ state: "done", tokens: 31_000, startedAt: 0, endedAt: 48_000 })).toBe("31k tokens · done after 48s");
    expect(agentMeta({ state: "running", activity: "Editing policy.rs" })).toBe("Editing policy.rs");
    expect(agentMeta({ state: "running" })).toBe("running");
    expect(agentMeta({ state: "failed", startedAt: 0, endedAt: 5_000 })).toBe("failed after 5s");
    expect(agentMeta({ state: "stopped" })).toBe("stopped");
  });

  it("takes the first line with words in it", () => {
    expect(firstLine("\n\n  Find every caller\nmore")).toBe("Find every caller");
  });

  it("names a native subagent by its type, else what it was for", () => {
    expect(nativeName({ kind: "agent", description: "Explore the repo", agentType: "Explore" })).toBe("Explore");
    expect(nativeName({ kind: "agent", description: "Explore the repo" })).toBe("Explore the repo");
  });

  it("has a report only once the call brought something back", () => {
    expect(nativeReport(tool({ kind: "agent", description: "d", output: "  4 callers " }))).toBe("4 callers");
    expect(nativeReport(tool({ kind: "agent", description: "d" }))).toBeNull();
  });
});

describe("long text", () => {
  it("folds after seven lines, with two lines of slack", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
    expect(foldsLongText(lines(9))).toBe(false);
    expect(foldsLongText(lines(10))).toBe(true);
  });
});

describe("what a Crew call started", () => {
  it("reads delegate as a subagent, start_session as a session and start_sessions as several", () => {
    const message = (what: string) => tool({ kind: "message", to: "scout", text: "go", what, toId: "s1", toName: "Scout" });
    expect(startedOf(message("start"))).toMatchObject({ kind: "subagent", target: { id: "s1", name: "Scout" } });
    expect(startedOf(message("launch"))).toMatchObject({ kind: "session" });
    expect(startedOf(message("handoff"))).toBeNull();
    expect(startedOf(tool({ kind: "message", to: "x", text: "", what: "start", error: "no" }))).toBeNull();
    expect(startedOf(tool({ kind: "crew", verb: "start_sessions", targets: [{ name: "a" }] }))).toMatchObject({ kind: "sessions" });
    expect(startedOf(tool({ kind: "crew", verb: "read_session", targets: [] }))).toBeNull();
  });

  it("counts the sessions that started and the ones that did not", () => {
    expect(startedSessionsSentence([{ name: "a" }, { name: "b" }, { name: "c" }])).toBe("Started 3 sessions");
    expect(startedSessionsSentence([{ name: "a" }, { name: "b", note: "no repo" }])).toBe("Started 1 session, 1 failed");
  });
});

describe("the rows a transcript groups into", () => {
  let next = 0;
  const block = (role: Block["role"], text: string, extra: Partial<Block> = {}): Block => {
    next += 1;
    return { id: `b${next}`, role, text, ...extra };
  };
  const kinds = (rows: Row[]) => rows.map((row) => row.kind);
  const call = (name: string, detail: ToolDetail, status: "pending" | "completed" = "completed") =>
    block("tool", name, { tool: { callId: `c${next}`, name, title: name, status, detail } });
  const agent = (extra: Record<string, unknown> = {}) =>
    call("Task", { kind: "agent", description: "Explore", prompt: "Look around", ...extra } as never);
  const scout = { id: "s1", name: "scout", kind: "session" };

  it("draws a native subagent call as a row of its own, foreground or background, out of the group around it", () => {
    const rows = groupRows([block("tool", "npm test"), agent(), agent({ background: true }), block("tool", "npm run lint")]);
    expect(kinds(rows)).toEqual(["activity", "subagent", "subagent", "activity"]);
  });

  it("draws delegate, start_session and start_sessions as started rows, and keeps a handoff and a refusal as they were", () => {
    const start = (what: string, extra: Record<string, unknown> = {}) =>
      call("delegate", { kind: "message", to: "scout", text: "go", what, letterId: `L${next}`, toId: `s${next}`, toName: "scout", ...extra } as never);
    const rows = groupRows([
      start("start"),
      start("launch"),
      call("start_sessions", { kind: "crew", verb: "start_sessions", targets: [{ id: "a", name: "a" }, { name: "b", note: "no repo" }] }),
      start("handoff"),
      start("start", { error: "nope", letterId: undefined }),
    ]);
    expect(kinds(rows)).toEqual(["started", "started", "started", "letter", "refused"]);
  });

  it("drops the note a start leaves, by the letter or by the session it names", () => {
    const delegated = call("delegate", { kind: "message", to: "scout", text: "go", what: "start", letterId: "L1", toId: "s1", toName: "scout" });
    const unanswered = call("delegate", { kind: "message", to: "lint", text: "go", what: "start" }, "pending");
    const rows = groupRows([
      delegated,
      block("system", "Delegated to subagent scout (s1)", { letterId: "L1" }),
      unanswered,
      block("system", "Delegated to subagent lint (s2)", { letterId: "L2" }),
    ]);
    // The second note stays: no row names s2, and it is the only trace the start left.
    expect(kinds(rows)).toEqual(["started", "started", "letter"]);
  });

  it("draws a report letter as a report row, and a plain letter as a letter", () => {
    const report = block("user", "4 callers", { fromBot: scout, letterId: "L9", letterKind: "report" });
    const plain = block("user", "fyi", { fromBot: scout, letterId: "L10", letterKind: "message" });
    const rows = groupRows([report, plain]);
    expect(kinds(rows)).toEqual(["report", "letter"]);
    expect(speaker(rows[0]!)).toBe("meta");
  });

  it("still starts a turn at a report, and leaves a subagent, a start and a report on the rail when the turn folds", () => {
    const report = block("user", "done", { fromBot: scout, letterId: "L9", letterKind: "report" });
    const rows = foldTurns(
      groupRows([
        block("user", "go", { at: 1_000 }),
        block("tool", "a"),
        agent(),
        call("delegate", { kind: "message", to: "x", text: "go", what: "start", letterId: "L1" }),
        block("tool", "b"),
        block("assistant", "all done", { at: 5_000 }),
        report,
        block("assistant", "thanks", { at: 6_000 }),
      ]),
      false,
    );
    expect(kinds(rows)).toEqual(["date", "message", "fold", "subagent", "started", "message", "report", "message"]);
  });
});
