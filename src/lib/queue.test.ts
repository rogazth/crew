import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import type { ThreadLetter } from "./protocol";
import { moved, othersPending, userQueue, whileWorkingOf } from "./queue";

const YOU = { id: "", name: "You", kind: "user" };
const LEAD = { id: "lead", name: "Lead", kind: "bot" };

const letter = (id: string, from: ThreadLetter["from"], queue: ThreadLetter["queue"] = "waiting", files?: string[]): ThreadLetter => ({
  id,
  from,
  to: { id: "s", name: "S" },
  kind: "message",
  text: id,
  at: 1,
  state: queue === "steering" ? "claimed" : "pending",
  queue,
  ...(files ? { files } : {}),
});

describe("what Enter does while a turn runs", () => {
  it("steers where the CLI reads it mid-turn, queues elsewhere, and does nothing for a bot", () => {
    expect(whileWorkingOf("terminal", "claude")).toBe("steer");
    expect(whileWorkingOf("child", "codex")).toBe("steer");
    expect(whileWorkingOf("terminal", "opencode")).toBe("queue");
    expect(whileWorkingOf("child", "cursor")).toBe("queue");
    expect(whileWorkingOf("bot", "claude")).toBeUndefined();
  });
});

describe("the user's queue", () => {
  it("keeps the user's own letters the transcript does not show, steers first", () => {
    const blocks: Block[] = [{ id: "b", role: "user", text: "turn", letterId: "turn" }];
    const pending = [
      letter("turn", YOU, "steering"),
      letter("later", YOU, "waiting", ["/a.png"]),
      letter("report", LEAD),
      letter("now", YOU, "steering"),
    ];
    expect(userQueue(pending, blocks)).toEqual([
      { id: "now", text: "now", files: [], steering: true },
      { id: "later", text: "later", files: ["/a.png"], steering: false },
    ]);
    expect(othersPending(pending).map((l) => l.id)).toEqual(["report"]);
  });

  it("moves a waiting message among the waiting ones only", () => {
    const queue = [
      { id: "s", text: "", files: [], steering: true },
      { id: "a", text: "", files: [], steering: false },
      { id: "b", text: "", files: [], steering: false },
    ];
    expect(moved(queue, "b", -1)).toEqual(["b", "a"]);
    expect(moved(queue, "a", -1)).toEqual(["a", "b"]);
    expect(moved(queue, "b", 1)).toEqual(["a", "b"]);
  });
});
