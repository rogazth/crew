import { describe, expect, it } from "vitest";
import type { Block, ThreadLetter, ThreadPair, ToolDetail } from "./protocol";
import {
  checkpointOf,
  childState,
  childrenOf,
  failedUnseen,
  isLetter,
  mergeLetters,
  pairThread,
  queuedLetters,
  refusalOf,
  resolveParty,
  rightSide,
  senderId,
  unseen,
  USER,
  YOU,
  type Party,
} from "./letters";
import type { Session } from "./types";

const LEAD: Party = { id: "lead", name: "Lead" };
const AUTH: Party = { id: "auth", name: "Auth refactor", kind: "session" };

function sent(detail: Partial<Extract<ToolDetail, { kind: "message" }>>, extra: Partial<Block> = {}): Block {
  return {
    id: "t1",
    role: "tool",
    text: "send_message",
    at: 100,
    tool: { callId: "c1", name: "send_message", title: "send_message", status: "completed", detail: { kind: "message", to: "auth", text: "go", ...detail } },
    ...extra,
  };
}

const session = (id: string, extra: Partial<Session> = {}) =>
  ({ id, name: id, kind: "child", status: "idle", provider: "claude", createdAt: 0, ...extra }) as Session;

describe("checkpointOf", () => {
  it("reads a sent letter off the call's row", () => {
    const block = sent({ letterId: "L1", toId: "auth", toName: "Auth refactor" });
    expect(checkpointOf(block, LEAD)).toEqual({ letterId: "L1", from: LEAD, to: { id: "auth", name: "Auth refactor" }, at: 100 });
  });

  it("reads a received one off the turn it started", () => {
    const block: Block = { id: "u1", role: "user", text: "done", letterId: "L2", fromBot: { id: "auth", name: "Auth refactor", kind: "session" } };
    expect(checkpointOf(block, LEAD)).toMatchObject({ letterId: "L2", from: AUTH, to: LEAD });
  });

  it("takes the person writing from the command line for the user", () => {
    const block: Block = { id: "u1", role: "user", text: "hi", letterId: "L3", fromBot: { id: "", name: "You", kind: "user" } };
    expect(checkpointOf(block, LEAD)?.from).toBe(YOU);
  });

  it("reads who a start and a write to a child were between off their notes", () => {
    const started: Block = { id: "s1", role: "system", text: "Started session Auth refactor (auth)", letterId: "L4" };
    expect(checkpointOf(started, LEAD)).toMatchObject({ from: LEAD, to: { id: "auth", name: "Auth refactor" } });
    const handed: Block = { id: "s2", role: "system", text: "Handed Docs pass (docs) to the user", letterId: "L5" };
    expect(checkpointOf(handed, LEAD)?.to).toMatchObject({ id: "docs", name: "Docs pass" });
    const wrote: Block = { id: "s3", role: "system", text: "You wrote to Auth refactor", letterId: "L6" };
    expect(checkpointOf(wrote, LEAD)).toMatchObject({ from: YOU, to: { id: "", name: "Auth refactor" } });
  });

  it("is no checkpoint for the user's own message, a pending call, or a refused one", () => {
    expect(isLetter({ id: "u", role: "user", text: "hi", letterId: "L7" })).toBe(false);
    expect(isLetter(sent({}))).toBe(false);
    expect(isLetter(sent({ letterId: "L8", error: "nope" }))).toBe(false);
    expect(checkpointOf({ id: "a", role: "assistant", text: "ok" }, LEAD)).toBeNull();
  });
});

describe("refusalOf", () => {
  it("says to whom, what and why", () => {
    expect(refusalOf(sent({ letterId: "L1" }))).toBeNull();
    expect(refusalOf(sent({ to: "lead", text: "hello me", error: "You cannot message yourself." }))).toEqual({
      to: "lead",
      text: "hello me",
      reason: "You cannot message yourself.",
    });
  });
});

describe("resolveParty", () => {
  it("finds the child a note names among the owner's children", () => {
    const sessions = [session("auth", { name: "Auth refactor", parentId: "lead" }), session("x", { name: "Auth refactor", parentId: "other" })];
    expect(resolveParty({ id: "", name: "Auth refactor" }, sessions, "lead").id).toBe("auth");
    expect(resolveParty(YOU, sessions, "lead")).toBe(YOU);
  });
});

describe("queuedLetters", () => {
  const letter = (id: string, from: ThreadLetter["from"]): ThreadLetter => ({
    id,
    from,
    to: { id: "lead", name: "Lead" },
    kind: "report",
    text: "report",
    at: 5,
    state: "pending",
  });

  it("drops one a turn already carries and keeps the rest as queued blocks", () => {
    const held: Block[] = [{ id: "u", role: "user", text: "x", letterId: "claimed", fromBot: AUTH }];
    const out = queuedLetters([letter("claimed", AUTH), letter("waiting", AUTH), letter("mine", { id: "", name: "You", kind: "user" })], held);
    expect(out.map((block) => block.letterId)).toEqual(["waiting", "mine"]);
    expect(out[0]).toMatchObject({ role: "user", streaming: true, fromBot: AUTH });
    expect(out[1]!.fromBot).toBeUndefined();
  });
});

describe("children", () => {
  it("says where a child stands: working first, then its last event", () => {
    expect(childState({ status: "working", lastEvent: { kind: "report", at: 1, cursor: 1 } })).toBe("working");
    expect(childState({ status: "idle", lastEvent: { kind: "report", at: 1, cursor: 1 } })).toBe("reported");
    expect(childState({ status: "needs-input", lastEvent: { kind: "approval", at: 1, cursor: 1 } })).toBe("approval");
    expect(childState({ status: "error" })).toBe("failed");
  });

  it("lists only owned children, oldest first; a handoff is nobody's", () => {
    const list = [
      session("b", { parentId: "lead", createdAt: 2 }),
      session("a", { parentId: "lead", createdAt: 1 }),
      session("h", { kind: "terminal", handedOffBy: "lead" }),
    ];
    expect(childrenOf(list).get("lead")?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(childrenOf(list).size).toBe(1);
  });

  it("is unread past what the user saw, and a failure only until then", () => {
    expect(unseen({ cursor: 5, userSeen: 4 })).toBe(true);
    expect(unseen({ cursor: 5, userSeen: 5 })).toBe(false);
    expect(failedUnseen({ lastEvent: { kind: "failed", at: 1, cursor: 5 }, userSeen: 4 })).toBe(true);
    expect(failedUnseen({ lastEvent: { kind: "failed", at: 1, cursor: 5 }, userSeen: 5 })).toBe(false);
    expect(failedUnseen({ lastEvent: { kind: "report", at: 1, cursor: 5 }, userSeen: 0 })).toBe(false);
  });
});

describe("threads", () => {
  const letter = (id: string, at: number, from = LEAD): ThreadLetter => ({
    id,
    from,
    to: AUTH,
    kind: "message",
    text: id,
    at,
    state: "delivered",
  });

  it("merges a page over what it holds, once each, oldest first", () => {
    const merged = mergeLetters([letter("b", 2), letter("c", 3)], [letter("a", 1), letter("b", 2)]);
    expect(merged.map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("puts the chat owner on the right, or the user when the owner is not in the pair", () => {
    expect(rightSide({ a: LEAD, b: AUTH }, LEAD)).toBe("lead");
    expect(rightSide({ a: YOU, b: AUTH }, LEAD)).toBe(USER);
    expect(senderId({ from: { id: "", name: "You", kind: "user" } })).toBe(USER);
  });

  it("opens a pair from this chat's side, and the user's write to a child as that pair", () => {
    const last = letter("a", 1);
    const mine: ThreadPair = { peer: { id: "auth", name: "Auth refactor", kind: "session" }, last, count: 3 };
    expect(pairThread(mine, LEAD)).toMatchObject({ a: LEAD, b: AUTH, label: "Auth refactor" });
    const theirs: ThreadPair = { peer: { id: "", name: "You", kind: "user" }, with: { id: "auth", name: "Auth refactor", kind: "session" }, last, count: 1 };
    expect(pairThread(theirs, LEAD)).toMatchObject({ a: YOU, b: AUTH, label: "You → Auth refactor" });
  });
});
